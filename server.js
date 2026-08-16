require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT) || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET =
    process.env.JWT_SECRET || "astro-online-secret-change-me";

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL || "admin@astro-online.ru";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "AstroAdmin123!";

/* =========================================================
   EXPRESS / SOCKET.IO
========================================================= */

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.json({ limit: "1mb" }));

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
    console.error("======================================");
    console.error("DATABASE_URL НЕ НАЙДЕН");
    console.error("Добавь DATABASE_URL в Environment на Render.");
    console.error("======================================");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
    console.error("PostgreSQL pool error:", err);
});

/* =========================================================
   HELPERS
========================================================= */

function signToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            isAdmin: user.is_admin === true
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );
}

function getToken(req) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
        return null;
    }

    return header.substring(7);
}

async function getUserFromRequest(req) {
    const token = getToken(req);

    if (!token) {
        return null;
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);

        const result = await pool.query(
            `
            SELECT
                id,
                username,
                email,
                balance,
                elo,
                xp,
                wins,
                is_admin,
                created_at
            FROM astro_users
            WHERE id = $1
            LIMIT 1
            `,
            [payload.id]
        );

        if (!result.rows.length) {
            return null;
        }

        return result.rows[0];
    } catch (error) {
        return null;
    }
}

async function requireAuth(req, res, next) {
    try {
        const user = await getUserFromRequest(req);

        if (!user) {
            return res.status(401).json({
                error: "Необходим вход в аккаунт"
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Ошибка авторизации"
        });
    }
}

async function requireAdmin(req, res, next) {
    try {
        const user = await getUserFromRequest(req);

        if (!user) {
            return res.status(401).json({
                error: "Необходим вход"
            });
        }

        if (!user.is_admin) {
            return res.status(403).json({
                error: "Нет доступа к админке"
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Ошибка проверки администратора"
        });
    }
}

function cleanString(value, max = 200) {
    return String(value ?? "")
        .trim()
        .slice(0, max);
}

function numberValue(value, fallback = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return number;
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: Number(user.balance || 0),
        elo: Number(user.elo || 0),
        xp: Number(user.xp || 0),
        wins: Number(user.wins || 0),
        isAdmin: user.is_admin === true
    };
}

/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {
    console.log("ASTRO: подключение к PostgreSQL...");

    await pool.query("SELECT NOW()");

    console.log("ASTRO: PostgreSQL подключен.");

    /*
       USERS
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS astro_users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(40) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,

            balance BIGINT NOT NULL DEFAULT 0,
            elo INTEGER NOT NULL DEFAULT 1000,
            xp BIGINT NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,

            is_admin BOOLEAN NOT NULL DEFAULT FALSE,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    /*
       RANKS

       rank_id — строковый ID ранга.
       Именно его использует index.html.
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id BIGSERIAL PRIMARY KEY,

            rank_id VARCHAR(100) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            title VARCHAR(200) NOT NULL DEFAULT '',

            price BIGINT NOT NULL DEFAULT 0,
            color VARCHAR(30) NOT NULL DEFAULT '#ffffff',
            icon VARCHAR(20) NOT NULL DEFAULT '★',

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    /*
       USER RANKS
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_ranks (
            id BIGSERIAL PRIMARY KEY,

            user_id BIGINT NOT NULL
                REFERENCES astro_users(id)
                ON DELETE CASCADE,

            rank_id BIGINT NOT NULL
                REFERENCES ranks(id)
                ON DELETE CASCADE,

            purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            UNIQUE(user_id, rank_id)
        )
    `);

    /*
       QUESTS
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quests (
            id BIGSERIAL PRIMARY KEY,

            quest_id VARCHAR(100) NOT NULL UNIQUE,
            title VARCHAR(200) NOT NULL,
            description TEXT NOT NULL DEFAULT '',

            reward BIGINT NOT NULL DEFAULT 0,
            xp BIGINT NOT NULL DEFAULT 0,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    /*
       QUEST CLAIMS
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quest_claims (
            id BIGSERIAL PRIMARY KEY,

            user_id BIGINT NOT NULL
                REFERENCES astro_users(id)
                ON DELETE CASCADE,

            quest_id BIGINT NOT NULL
                REFERENCES quests(id)
                ON DELETE CASCADE,

            claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            UNIQUE(user_id, quest_id)
        )
    `);

    /*
       INDEXES
    */

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_astro_users_elo
        ON astro_users(elo DESC)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_astro_users_username
        ON astro_users(username)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_ranks_user
        ON user_ranks(user_id)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_quest_claims_user
        ON quest_claims(user_id)
    `);

    /*
       DEFAULT RANKS
    */

    const defaultRanks = [
        {
            rankId: "bronze",
            name: "BRONZE",
            title: "Бронзовый",
            price: 5000,
            color: "#cd7f32",
            icon: "◆"
        },
        {
            rankId: "silver",
            name: "SILVER",
            title: "Серебряный",
            price: 15000,
            color: "#b9c3d0",
            icon: "◇"
        },
        {
            rankId: "gold",
            name: "GOLD",
            title: "Золотой",
            price: 35000,
            color: "#ffd45a",
            icon: "★"
        },
        {
            rankId: "diamond",
            name: "DIAMOND",
            title: "Алмазный",
            price: 75000,
            color: "#6ee7ff",
            icon: "✦"
        },
        {
            rankId: "master",
            name: "MASTER",
            title: "Мастер",
            price: 150000,
            color: "#c084fc",
            icon: "✪"
        },
        {
            rankId: "astro",
            name: "ASTRO",
            title: "ASTRO ELITE",
            price: 300000,
            color: "#ff66d6",
            icon: "✦"
        }
    ];

    for (const rank of defaultRanks) {
        await pool.query(
            `
            INSERT INTO ranks
                (rank_id, name, title, price, color, icon)
            VALUES
                ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (rank_id)
            DO NOTHING
            `,
            [
                rank.rankId,
                rank.name,
                rank.title,
                rank.price,
                rank.color,
                rank.icon
            ]
        );
    }

    /*
       DEFAULT QUESTS
    */

    const defaultQuests = [
        {
            questId: "daily-login",
            title: "Войти в систему",
            description: "Открой профиль и забери ежедневную награду.",
            reward: 50,
            xp: 25
        },
        {
            questId: "daily-explore",
            title: "Исследователь",
            description: "Посети разделы ASTRO и изучи новый космический сектор.",
            reward: 100,
            xp: 50
        },
        {
            questId: "daily-elite",
            title: "Elite Protocol",
            description: "Выполни особое задание сезона.",
            reward: 250,
            xp: 100
        }
    ];

    for (const quest of defaultQuests) {
        await pool.query(
            `
            INSERT INTO quests
                (quest_id, title, description, reward, xp)
            VALUES
                ($1, $2, $3, $4, $5)
            ON CONFLICT (quest_id)
            DO NOTHING
            `,
            [
                quest.questId,
                quest.title,
                quest.description,
                quest.reward,
                quest.xp
            ]
        );
    }

    /*
       DEFAULT ADMIN
    */

    const adminCheck = await pool.query(
        `
        SELECT id
        FROM astro_users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        `,
        [ADMIN_EMAIL]
    );

    if (!adminCheck.rows.length) {
        const passwordHash = await bcrypt.hash(
            ADMIN_PASSWORD,
            12
        );

        await pool.query(
            `
            INSERT INTO astro_users
                (
                    username,
                    email,
                    password_hash,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                )
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, TRUE)
            `,
            [
                "ASTRO ADMIN",
                ADMIN_EMAIL,
                passwordHash,
                1000000,
                99999,
                99999,
                9999
            ]
        );

        console.log("======================================");
        console.log("Создан администратор ASTRO");
        console.log("Email:", ADMIN_EMAIL);
        console.log("Password:", ADMIN_PASSWORD);
        console.log("======================================");
    } else {
        /*
           Если админ уже существует,
           просто гарантируем is_admin = TRUE.
        */

        await pool.query(
            `
            UPDATE astro_users
            SET is_admin = TRUE
            WHERE LOWER(email) = LOWER($1)
            `,
            [ADMIN_EMAIL]
        );
    }

    console.log("ASTRO database ready.");
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            ok: true,
            service: "ASTRO ONLINE",
            database: "connected"
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            ok: false,
            database: "error"
        });
    }
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const username = cleanString(req.body.username, 40);
        const email = cleanString(req.body.email, 255)
            .toLowerCase();
        const password = String(req.body.password || "");

        if (username.length < 3) {
            return res.status(400).json({
                error: "Никнейм должен содержать минимум 3 символа"
            });
        }

        if (!email.includes("@")) {
            return res.status(400).json({
                error: "Введите корректный email"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 6 символов"
            });
        }

        const existing = await pool.query(
            `
            SELECT id
            FROM astro_users
            WHERE LOWER(email) = LOWER($1)
               OR LOWER(username) = LOWER($2)
            LIMIT 1
            `,
            [email, username]
        );

        if (existing.rows.length) {
            return res.status(409).json({
                error: "Такой email или никнейм уже существует"
            });
        }

        const passwordHash = await bcrypt.hash(
            password,
            12
        );

        const result = await pool.query(
            `
            INSERT INTO astro_users
                (
                    username,
                    email,
                    password_hash,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                )
            VALUES
                ($1, $2, $3, 0, 1000, 0, 0, FALSE)
            RETURNING
                id,
                username,
                email,
                balance,
                elo,
                xp,
                wins,
                is_admin
            `,
            [
                username,
                email,
                passwordHash
            ]
        );

        const user = result.rows[0];

        const token = signToken(user);

        emitLeaderboard();

        res.json({
            token,
            user: publicUser(user)
        });
    } catch (error) {
        console.error("REGISTER ERROR:", error);

        res.status(500).json({
            error: "Ошибка регистрации"
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
    try {
        const email = cleanString(req.body.email, 255)
            .toLowerCase();

        const password = String(
            req.body.password || ""
        );

        const result = await pool.query(
            `
            SELECT
                id,
                username,
                email,
                password_hash,
                balance,
                elo,
                xp,
                wins,
                is_admin
            FROM astro_users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
            `,
            [email]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: "Неверный email или пароль"
            });
        }

        const user = result.rows[0];

        const correct = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!correct) {
            return res.status(401).json({
                error: "Неверный email или пароль"
            });
        }

        const token = signToken(user);

        res.json({
            token,
            user: publicUser(user)
        });
    } catch (error) {
        console.error("LOGIN ERROR:", error);

        res.status(500).json({
            error: "Ошибка входа"
        });
    }
});

/* =========================================================
   ME
========================================================= */

app.get("/api/me", requireAuth, async (req, res) => {
    try {
        const userResult = await pool.query(
            `
            SELECT
                id,
                username,
                email,
                balance,
                elo,
                xp,
                wins,
                is_admin,
                created_at
            FROM astro_users
            WHERE id = $1
            `,
            [req.user.id]
        );

        const user = userResult.rows[0];

        const rankResult = await pool.query(
            `
            SELECT
                r.id,
                r.rank_id,
                r.name,
                r.title,
                r.price,
                r.color,
                r.icon,
                ur.purchased_at
            FROM user_ranks ur
            JOIN ranks r
                ON r.id = ur.rank_id
            WHERE ur.user_id = $1
            ORDER BY ur.purchased_at DESC
            `,
            [user.id]
        );

        res.json({
            user: {
                ...publicUser(user),
                ownedRanks: rankResult.rows.map((rank) => ({
                    id: rank.id,
                    rankId: rank.rank_id,
                    name: rank.name,
                    title: rank.title,
                    price: Number(rank.price),
                    color: rank.color,
                    icon: rank.icon,
                    purchasedAt: rank.purchased_at
                }))
            }
        });
    } catch (error) {
        console.error("ME ERROR:", error);

        res.status(500).json({
            error: "Ошибка загрузки профиля"
        });
    }
});

/* =========================================================
   RANKS
========================================================= */

app.get("/api/ranks", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                id,
                rank_id AS "rankId",
                name,
                title,
                price,
                color,
                icon,
                created_at
            FROM ranks
            ORDER BY price ASC, id ASC
            `
        );

        res.json({
            ranks: result.rows.map((rank) => ({
                id: rank.id,
                rankId: rank.rankId,
                name: rank.name,
                title: rank.title,
                price: Number(rank.price),
                color: rank.color,
                icon: rank.icon,
                createdAt: rank.created_at
            }))
        });
    } catch (error) {
        console.error("RANKS ERROR:", error);

        res.status(500).json({
            error: "Ошибка загрузки рангов"
        });
    }
});

/* =========================================================
   BUY RANK
========================================================= */

app.post(
    "/api/ranks/:id/buy",
    requireAuth,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const rankResult = await client.query(
                `
                SELECT
                    id,
                    rank_id,
                    name,
                    title,
                    price,
                    color,
                    icon
                FROM ranks
                WHERE rank_id = $1
                LIMIT 1
                FOR UPDATE
                `,
                [req.params.id]
            );

            if (!rankResult.rows.length) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "Ранг не найден"
                });
            }

            const rank = rankResult.rows[0];

            const userResult = await client.query(
                `
                SELECT
                    id,
                    username,
                    email,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                FROM astro_users
                WHERE id = $1
                LIMIT 1
                FOR UPDATE
                `,
                [req.user.id]
            );

            const user = userResult.rows[0];

            const owned = await client.query(
                `
                SELECT id
                FROM user_ranks
                WHERE user_id = $1
                  AND rank_id = $2
                LIMIT 1
                `,
                [
                    user.id,
                    rank.id
                ]
            );

            if (owned.rows.length) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Этот ранг уже куплен"
                });
            }

            if (Number(user.balance) < Number(rank.price)) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Недостаточно средств"
                });
            }

            await client.query(
                `
                UPDATE astro_users
                SET balance = balance - $1
                WHERE id = $2
                `,
                [
                    rank.price,
                    user.id
                ]
            );

            await client.query(
                `
                INSERT INTO user_ranks
                    (user_id, rank_id)
                VALUES
                    ($1, $2)
                `,
                [
                    user.id,
                    rank.id
                ]
            );

            const finalResult = await client.query(
                `
                SELECT
                    id,
                    username,
                    email,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                FROM astro_users
                WHERE id = $1
                `,
                [user.id]
            );

            await client.query("COMMIT");

            res.json({
                user: publicUser(finalResult.rows[0]),
                rank: {
                    rankId: rank.rank_id,
                    name: rank.name,
                    title: rank.title,
                    price: Number(rank.price),
                    color: rank.color,
                    icon: rank.icon
                }
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error("BUY RANK ERROR:", error);

            res.status(500).json({
                error: "Ошибка покупки ранга"
            });
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   QUESTS
========================================================= */

app.get("/api/quests", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                id,
                quest_id AS "questId",
                title,
                description,
                reward,
                xp,
                created_at
            FROM quests
            ORDER BY id DESC
            `
        );

        res.json({
            quests: result.rows.map((quest) => ({
                id: quest.id,
                questId: quest.questId,
                title: quest.title,
                description: quest.description,
                reward: Number(quest.reward),
                xp: Number(quest.xp),
                createdAt: quest.created_at
            }))
        });
    } catch (error) {
        console.error("QUESTS ERROR:", error);

        res.status(500).json({
            error: "Ошибка загрузки квестов"
        });
    }
});

/* =========================================================
   CLAIM QUEST
========================================================= */

app.post(
    "/api/quests/:id/claim",
    requireAuth,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const questResult = await client.query(
                `
                SELECT
                    id,
                    quest_id,
                    title,
                    description,
                    reward,
                    xp
                FROM quests
                WHERE quest_id = $1
                LIMIT 1
                FOR UPDATE
                `,
                [req.params.id]
            );

            if (!questResult.rows.length) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "Квест не найден"
                });
            }

            const quest = questResult.rows[0];

            const alreadyClaimed = await client.query(
                `
                SELECT id
                FROM quest_claims
                WHERE user_id = $1
                  AND quest_id = $2
                LIMIT 1
                `,
                [
                    req.user.id,
                    quest.id
                ]
            );

            if (alreadyClaimed.rows.length) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Этот квест уже выполнен"
                });
            }

            await client.query(
                `
                INSERT INTO quest_claims
                    (user_id, quest_id)
                VALUES
                    ($1, $2)
                `,
                [
                    req.user.id,
                    quest.id
                ]
            );

            await client.query(
                `
                UPDATE astro_users
                SET
                    balance = balance + $1,
                    xp = xp + $2
                WHERE id = $3
                `,
                [
                    quest.reward,
                    quest.xp,
                    req.user.id
                ]
            );

            const userResult = await client.query(
                `
                SELECT
                    id,
                    username,
                    email,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                FROM astro_users
                WHERE id = $1
                `,
                [req.user.id]
            );

            await client.query("COMMIT");

            emitLeaderboard();

            res.json({
                reward: Number(quest.reward),
                xp: Number(quest.xp),
                user: publicUser(userResult.rows[0])
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error("CLAIM QUEST ERROR:", error);

            res.status(500).json({
                error: "Ошибка выполнения квеста"
            });
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   LEADERBOARD
========================================================= */

app.get("/api/leaderboard", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                u.id,
                u.username,
                u.elo,
                u.xp,
                u.wins,

                COALESCE(
                    (
                        SELECT r.name
                        FROM user_ranks ur
                        JOIN ranks r
                            ON r.id = ur.rank_id
                        WHERE ur.user_id = u.id
                        ORDER BY r.price DESC
                        LIMIT 1
                    ),
                    'Без ранга'
                ) AS rank_name

            FROM astro_users u

            ORDER BY
                u.elo DESC,
                u.wins DESC,
                u.xp DESC,
                u.id ASC

            LIMIT 100
            `
        );

        res.json({
            players: result.rows.map((player) => ({
                id: player.id,
                username: player.username,
                elo: Number(player.elo),
                xp: Number(player.xp),
                wins: Number(player.wins),
                rank: player.rank_name
            }))
        });
    } catch (error) {
        console.error("LEADERBOARD ERROR:", error);

        res.status(500).json({
            error: "Ошибка загрузки рейтинга"
        });
    }
});

/* =========================================================
   ADMIN - USERS
========================================================= */

app.get(
    "/api/admin/users",
    requireAdmin,
    async (req, res) => {
        try {
            const search = cleanString(
                req.query.search,
                100
            );

            let result;

            if (search) {
                result = await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email,
                        balance,
                        elo,
                        xp,
                        wins,
                        is_admin,
                        created_at
                    FROM astro_users
                    WHERE
                        username ILIKE $1
                        OR email ILIKE $1
                    ORDER BY id DESC
                    LIMIT 100
                    `,
                    [`%${search}%`]
                );
            } else {
                result = await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email,
                        balance,
                        elo,
                        xp,
                        wins,
                        is_admin,
                        created_at
                    FROM astro_users
                    ORDER BY id DESC
                    LIMIT 100
                    `
                );
            }

            res.json({
                users: result.rows.map((user) => ({
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    balance: Number(user.balance),
                    elo: Number(user.elo),
                    xp: Number(user.xp),
                    wins: Number(user.wins),
                    isAdmin: user.is_admin,
                    createdAt: user.created_at
                }))
            });
        } catch (error) {
            console.error("ADMIN USERS ERROR:", error);

            res.status(500).json({
                error: "Ошибка загрузки игроков"
            });
        }
    }
);

/* =========================================================
   ADMIN - UPDATE USER
========================================================= */

app.put(
    "/api/admin/users/:id",
    requireAdmin,
    async (req, res) => {
        try {
            const id = Number(req.params.id);

            if (!Number.isInteger(id)) {
                return res.status(400).json({
                    error: "Неверный ID игрока"
                });
            }

            const elo = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.elo, 1000)
                )
            );

            const wins = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.wins, 0)
                )
            );

            const balance = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.balance, 0)
                )
            );

            const xp = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.xp, 0)
                )
            );

            const result = await pool.query(
                `
                UPDATE astro_users
                SET
                    elo = $1,
                    wins = $2,
                    balance = $3,
                    xp = $4
                WHERE id = $5

                RETURNING
                    id,
                    username,
                    email,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                `,
                [
                    elo,
                    wins,
                    balance,
                    xp,
                    id
                ]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    error: "Игрок не найден"
                });
            }

            emitLeaderboard();

            res.json({
                user: publicUser(result.rows[0])
            });
        } catch (error) {
            console.error("ADMIN UPDATE USER ERROR:", error);

            res.status(500).json({
                error: "Ошибка сохранения игрока"
            });
        }
    }
);

/* =========================================================
   ADMIN - RANKS
========================================================= */

app.get(
    "/api/admin/ranks",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    rank_id AS "rankId",
                    name,
                    title,
                    price,
                    color,
                    icon,
                    created_at
                FROM ranks
                ORDER BY price ASC, id ASC
                `
            );

            res.json({
                ranks: result.rows.map((rank) => ({
                    id: rank.id,
                    rankId: rank.rankId,
                    name: rank.name,
                    title: rank.title,
                    price: Number(rank.price),
                    color: rank.color,
                    icon: rank.icon,
                    createdAt: rank.created_at
                }))
            });
        } catch (error) {
            console.error("ADMIN RANKS ERROR:", error);

            res.status(500).json({
                error: "Ошибка загрузки рангов"
            });
        }
    }
);

/* =========================================================
   ADMIN - CREATE RANK
========================================================= */

app.post(
    "/api/admin/ranks",
    requireAdmin,
    async (req, res) => {
        try {
            const rankId = cleanString(
                req.body.rankId,
                100
            );

            const name = cleanString(
                req.body.name,
                100
            );

            const title = cleanString(
                req.body.title,
                200
            );

            const price = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.price, 0)
                )
            );

            const color =
                cleanString(
                    req.body.color,
                    30
                ) || "#ffffff";

            const icon =
                cleanString(
                    req.body.icon,
                    20
                ) || "★";

            if (!rankId || !name) {
                return res.status(400).json({
                    error: "ID и название ранга обязательны"
                });
            }

            const result = await pool.query(
                `
                INSERT INTO ranks
                    (
                        rank_id,
                        name,
                        title,
                        price,
                        color,
                        icon
                    )
                VALUES
                    ($1, $2, $3, $4, $5, $6)

                RETURNING
                    id,
                    rank_id AS "rankId",
                    name,
                    title,
                    price,
                    color,
                    icon
                `,
                [
                    rankId,
                    name,
                    title,
                    price,
                    color,
                    icon
                ]
            );

            io.emit("ranks:update");

            res.json({
                rank: {
                    id: result.rows[0].id,
                    rankId: result.rows[0].rankId,
                    name: result.rows[0].name,
                    title: result.rows[0].title,
                    price: Number(result.rows[0].price),
                    color: result.rows[0].color,
                    icon: result.rows[0].icon
                }
            });
        } catch (error) {
            console.error("CREATE RANK ERROR:", error);

            if (error.code === "23505") {
                return res.status(409).json({
                    error: "Ранг с таким ID уже существует"
                });
            }

            res.status(500).json({
                error: "Ошибка создания ранга"
            });
        }
    }
);

/* =========================================================
   ADMIN - DELETE RANK
========================================================= */

app.delete(
    "/api/admin/ranks/:id",
    requireAdmin,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const rankId = Number(req.params.id);

            if (!Number.isInteger(rankId)) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Неверный ID ранга"
                });
            }

            await client.query(
                `
                DELETE FROM user_ranks
                WHERE rank_id = $1
                `,
                [rankId]
            );

            const result = await client.query(
                `
                DELETE FROM ranks
                WHERE id = $1
                RETURNING id
                `,
                [rankId]
            );

            if (!result.rows.length) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "Ранг не найден"
                });
            }

            await client.query("COMMIT");

            io.emit("ranks:update");

            res.json({
                ok: true
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error("DELETE RANK ERROR:", error);

            res.status(500).json({
                error: "Ошибка удаления ранга"
            });
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   ADMIN - QUESTS
========================================================= */

app.get(
    "/api/admin/quests",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    quest_id AS "questId",
                    title,
                    description,
                    reward,
                    xp,
                    created_at
                FROM quests
                ORDER BY id DESC
                `
            );

            res.json({
                quests: result.rows.map((quest) => ({
                    id: quest.id,
                    questId: quest.questId,
                    title: quest.title,
                    description: quest.description,
                    reward: Number(quest.reward),
                    xp: Number(quest.xp),
                    createdAt: quest.created_at
                }))
            });
        } catch (error) {
            console.error("ADMIN QUESTS ERROR:", error);

            res.status(500).json({
                error: "Ошибка загрузки квестов"
            });
        }
    }
);

/* =========================================================
   ADMIN - CREATE QUEST
========================================================= */

app.post(
    "/api/admin/quests",
    requireAdmin,
    async (req, res) => {
        try {
            const questId = cleanString(
                req.body.questId,
                100
            );

            const title = cleanString(
                req.body.title,
                200
            );

            const description = cleanString(
                req.body.description,
                1000
            );

            const reward = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.reward, 0)
                )
            );

            const xp = Math.max(
                0,
                Math.floor(
                    numberValue(req.body.xp, 0)
                )
            );

            if (!questId || !title) {
                return res.status(400).json({
                    error: "ID и название квеста обязательны"
                });
            }

            const result = await pool.query(
                `
                INSERT INTO quests
                    (
                        quest_id,
                        title,
                        description,
                        reward,
                        xp
                    )
                VALUES
                    ($1, $2, $3, $4, $5)

                RETURNING
                    id,
                    quest_id AS "questId",
                    title,
                    description,
                    reward,
                    xp
                `,
                [
                    questId,
                    title,
                    description,
                    reward,
                    xp
                ]
            );

            io.emit("quests:update");

            res.json({
                quest: {
                    id: result.rows[0].id,
                    questId: result.rows[0].questId,
                    title: result.rows[0].title,
                    description: result.rows[0].description,
                    reward: Number(result.rows[0].reward),
                    xp: Number(result.rows[0].xp)
                }
            });
        } catch (error) {
            console.error("CREATE QUEST ERROR:", error);

            if (error.code === "23505") {
                return res.status(409).json({
                    error: "Квест с таким ID уже существует"
                });
            }

            res.status(500).json({
                error: "Ошибка создания квеста"
            });
        }
    }
);

/* =========================================================
   ADMIN - DELETE QUEST
========================================================= */

app.delete(
    "/api/admin/quests/:id",
    requireAdmin,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const questId = Number(req.params.id);

            if (!Number.isInteger(questId)) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Неверный ID квеста"
                });
            }

            await client.query(
                `
                DELETE FROM quest_claims
                WHERE quest_id = $1
                `,
                [questId]
            );

            const result = await client.query(
                `
                DELETE FROM quests
                WHERE id = $1
                RETURNING id
                `,
                [questId]
            );

            if (!result.rows.length) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "Квест не найден"
                });
            }

            await client.query("COMMIT");

            io.emit("quests:update");

            res.json({
                ok: true
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error("DELETE QUEST ERROR:", error);

            res.status(500).json({
                error: "Ошибка удаления квеста"
            });
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   ADMIN - CHANGE ADMIN STATUS
========================================================= */

app.put(
    "/api/admin/users/:id/admin",
    requireAdmin,
    async (req, res) => {
        try {
            const id = Number(req.params.id);

            if (!Number.isInteger(id)) {
                return res.status(400).json({
                    error: "Неверный ID"
                });
            }

            const isAdmin =
                req.body.isAdmin === true;

            if (
                Number(req.user.id) === id &&
                !isAdmin
            ) {
                return res.status(400).json({
                    error: "Нельзя снять права у самого себя"
                });
            }

            const result = await pool.query(
                `
                UPDATE astro_users
                SET is_admin = $1
                WHERE id = $2
                RETURNING
                    id,
                    username,
                    email,
                    is_admin
                `,
                [
                    isAdmin,
                    id
                ]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    error: "Игрок не найден"
                });
            }

            res.json({
                user: {
                    id: result.rows[0].id,
                    username: result.rows[0].username,
                    email: result.rows[0].email,
                    isAdmin: result.rows[0].is_admin
                }
            });
        } catch (error) {
            console.error(
                "ADMIN STATUS ERROR:",
                error
            );

            res.status(500).json({
                error: "Ошибка изменения прав"
            });
        }
    }
);

/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", (socket) => {
    console.log(
        "ASTRO socket connected:",
        socket.id
    );

    socket.on("disconnect", () => {
        console.log(
            "ASTRO socket disconnected:",
            socket.id
        );
    });
});

async function emitLeaderboard() {
    try {
        const result = await pool.query(
            `
            SELECT
                id,
                username,
                elo,
                xp,
                wins
            FROM astro_users

            ORDER BY
                elo DESC,
                wins DESC,
                xp DESC,
                id ASC

            LIMIT 100
            `
        );

        io.emit(
            "leaderboard:update",
            {
                players: result.rows.map((player) => ({
                    id: player.id,
                    username: player.username,
                    elo: Number(player.elo),
                    xp: Number(player.xp),
                    wins: Number(player.wins)
                }))
            }
        );
    } catch (error) {
        console.error(
            "SOCKET LEADERBOARD ERROR:",
            error
        );
    }
}

/* =========================================================
   404 API
========================================================= */

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API путь не найден"
    });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
    console.error(
        "EXPRESS ERROR:",
        error
    );

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        error: "Внутренняя ошибка сервера"
    });
});

/* =========================================================
   START
========================================================= */

async function start() {
    try {
        await initDatabase();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log("======================================");
                console.log("🚀 ASTRO ONLINE");
                console.log("======================================");
                console.log(
                    "Server listening on port:",
                    PORT
                );
                console.log(
                    "Admin email:",
                    ADMIN_EMAIL
                );
                console.log("======================================");
            }
        );
    } catch (error) {
        console.error("======================================");
        console.error("FATAL SERVER ERROR:");
        console.error(error);
        console.error("======================================");

        process.exit(1);
    }
}

start();
