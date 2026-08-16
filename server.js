require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET =
    process.env.JWT_SECRET || "astro-secret-change-this";

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL || "admin@astro.local";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "AstroAdmin123!";

if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL не указан.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "2mb" }));

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /*
         * USERS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                email TEXT UNIQUE NOT NULL,

                username TEXT UNIQUE NOT NULL,

                password_hash TEXT NOT NULL,

                role TEXT NOT NULL DEFAULT 'user',

                balance BIGINT NOT NULL DEFAULT 1000,

                xp BIGINT NOT NULL DEFAULT 0,

                elo BIGINT NOT NULL DEFAULT 1000,

                wins BIGINT NOT NULL DEFAULT 0,

                owned_ranks JSONB NOT NULL DEFAULT '[]'::jsonb,

                claimed_quests JSONB NOT NULL DEFAULT '{}'::jsonb,

                history JSONB NOT NULL DEFAULT '[]'::jsonb,

                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

                last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        /*
         * MIGRATION FOR OLD USERS TABLE
         */

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT 1000
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS elo BIGINT NOT NULL DEFAULT 1000
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS wins BIGINT NOT NULL DEFAULT 0
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS owned_ranks JSONB NOT NULL DEFAULT '[]'::jsonb
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS claimed_quests JSONB NOT NULL DEFAULT '{}'::jsonb
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb
        `);

        /*
         * RANKS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS ranks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                rank_id TEXT UNIQUE NOT NULL,

                name TEXT NOT NULL,

                title TEXT NOT NULL DEFAULT '',

                price BIGINT NOT NULL DEFAULT 0,

                color TEXT NOT NULL DEFAULT '#9b6cff',

                icon TEXT NOT NULL DEFAULT '★',

                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        /*
         * QUESTS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS quests (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

                quest_id TEXT UNIQUE NOT NULL,

                title TEXT NOT NULL,

                description TEXT NOT NULL DEFAULT '',

                reward BIGINT NOT NULL DEFAULT 0,

                xp BIGINT NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        /*
         * DEFAULT RANKS
         */

        await client.query(`
            INSERT INTO ranks
                (rank_id,name,title,price,color,icon)
            VALUES
                ('bronze','BRONZE','Бронзовый',5000,'#cd7f32','◆'),
                ('silver','SILVER','Серебряный',15000,'#b9c3d0','◇'),
                ('gold','GOLD','Золотой',35000,'#ffd45a','✦'),
                ('diamond','DIAMOND','Алмазный',75000,'#6ee7ff','✧'),
                ('master','MASTER','Мастер',150000,'#c084fc','✹'),
                ('astro','ASTRO','ASTRO ELITE',300000,'#ff6bd6','★')
            ON CONFLICT (rank_id) DO NOTHING
        `);

        /*
         * DEFAULT QUESTS
         */

        await client.query(`
            INSERT INTO quests
                (quest_id,title,description,reward,xp)
            VALUES
                (
                    'daily-login',
                    'Войти в систему',
                    'Открой профиль и забери ежедневную награду.',
                    50,
                    25
                ),
                (
                    'daily-explore',
                    'Исследователь',
                    'Посети разделы ASTRO и изучи систему.',
                    100,
                    50
                ),
                (
                    'daily-elite',
                    'Elite Protocol',
                    'Выполни особое задание сезона.',
                    250,
                    100
                )
            ON CONFLICT (quest_id) DO NOTHING
        `);

        await client.query("COMMIT");

        console.log("✅ Database initialized");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

/* =========================================================
   HELPERS
========================================================= */

function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,

        balance: Number(user.balance || 0),
        xp: Number(user.xp || 0),
        elo: Number(user.elo || 0),
        wins: Number(user.wins || 0),

        ownedRanks: Array.isArray(user.owned_ranks)
            ? user.owned_ranks
            : [],

        claimedQuests:
            user.claimed_quests &&
            typeof user.claimed_quests === "object"
                ? user.claimed_quests
                : {},

        history: Array.isArray(user.history)
            ? user.history
            : [],

        createdAt: user.created_at,
        lastLoginAt: user.last_login_at
    };
}

function createToken(user) {
    return jwt.sign(
        {
            id: user.id,
            role: user.role
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );
}

async function getUserById(id) {
    const result = await pool.query(
        "SELECT * FROM users WHERE id = $1",
        [id]
    );

    return result.rows[0] || null;
}

async function auth(req, res, next) {
    try {
        const header =
            req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Требуется вход."
            });
        }

        const token = header.slice(7);

        const payload = jwt.verify(
            token,
            JWT_SECRET
        );

        const user =
            await getUserById(payload.id);

        if (!user) {
            return res.status(401).json({
                error: "Пользователь не найден."
            });
        }

        req.user = user;

        next();
    } catch (error) {
        return res.status(401).json({
            error: "Сессия недействительна."
        });
    }
}

function adminAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({
            error: "Требуется вход."
        });
    }

    if (req.user.role !== "admin") {
        return res.status(403).json({
            error: "Доступ только для администратора."
        });
    }

    next();
}

function broadcast(event) {
    io.emit(event);
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            ok: true,
            server: "ASTRO ONLINE",
            database: true
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            database: false
        });
    }
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const username =
            String(req.body?.username || "").trim();

        const email =
            String(req.body?.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body?.password || "");

        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                username
            )
        ) {
            return res.status(400).json({
                error:
                    "Никнейм должен содержать 3–20 символов."
            });
        }

        if (!/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({
                error: "Введите корректный email."
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error:
                    "Пароль должен содержать минимум 8 символов."
            });
        }

        const exists =
            await pool.query(
                `
                SELECT id
                FROM users
                WHERE lower(email) = lower($1)
                   OR lower(username) = lower($2)
                LIMIT 1
                `,
                [email, username]
            );

        if (exists.rowCount > 0) {
            return res.status(409).json({
                error:
                    "Email или никнейм уже занят."
            });
        }

        const passwordHash =
            await bcrypt.hash(password, 12);

        const result =
            await pool.query(
                `
                INSERT INTO users
                (
                    email,
                    username,
                    password_hash
                )
                VALUES
                ($1,$2,$3)
                RETURNING *
                `,
                [
                    email,
                    username,
                    passwordHash
                ]
            );

        const user = result.rows[0];

        broadcast("leaderboard:update");

        res.json({
            token: createToken(user),
            user: publicUser(user)
        });
    } catch (error) {
        console.error(
            "REGISTER ERROR:",
            error
        );

        res.status(500).json({
            error: "Не удалось создать аккаунт."
        });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const email =
            String(req.body?.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body?.password || "");

        const result =
            await pool.query(
                `
                SELECT *
                FROM users
                WHERE lower(email) = lower($1)
                LIMIT 1
                `,
                [email]
            );

        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({
                error:
                    "Неверный email или пароль."
            });
        }

        const valid =
            await bcrypt.compare(
                password,
                user.password_hash
            );

        if (!valid) {
            return res.status(401).json({
                error:
                    "Неверный email или пароль."
            });
        }

        await pool.query(
            `
            UPDATE users
            SET last_login_at = now()
            WHERE id = $1
            `,
            [user.id]
        );

        const fresh =
            await getUserById(user.id);

        res.json({
            token: createToken(fresh),
            user: publicUser(fresh)
        });
    } catch (error) {
        console.error(
            "LOGIN ERROR:",
            error
        );

        res.status(500).json({
            error: "Ошибка входа."
        });
    }
});

/* =========================================================
   PROFILE
========================================================= */

app.get(
    "/api/me",
    auth,
    async (req, res) => {
        const fresh =
            await getUserById(req.user.id);

        res.json({
            user: publicUser(fresh)
        });
    }
);

app.put(
    "/api/profile",
    auth,
    async (req, res) => {
        try {
            const username =
                String(
                    req.body?.username || ""
                ).trim();

            if (
                !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                    username
                )
            ) {
                return res.status(400).json({
                    error:
                        "Никнейм должен содержать 3–20 символов."
                });
            }

            const duplicate =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE lower(username)=lower($1)
                    AND id <> $2
                    LIMIT 1
                    `,
                    [
                        username,
                        req.user.id
                    ]
                );

            if (duplicate.rowCount) {
                return res.status(409).json({
                    error:
                        "Такой никнейм уже занят."
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET username=$1
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        username,
                        req.user.id
                    ]
                );

            broadcast("leaderboard:update");

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось изменить профиль."
            });
        }
    }
);

/* =========================================================
   RANKS
========================================================= */

app.get(
    "/api/ranks",
    async (req, res) => {
        try {
            const result =
                await pool.query(
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
                    ORDER BY price ASC, created_at ASC
                    `
                );

            res.json({
                ranks:
                    result.rows.map(rank => ({
                        id: rank.id,
                        rankId: rank.rank_id,
                        name: rank.name,
                        title: rank.title,
                        price: Number(rank.price),
                        color: rank.color,
                        icon: rank.icon
                    }))
            });
        } catch (error) {
            console.error(
                "RANKS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Ошибка загрузки рангов."
            });
        }
    }
);

app.post(
    "/api/ranks/:id/buy",
    auth,
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query("BEGIN");

            const rankResult =
                await client.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE rank_id=$1
                    LIMIT 1
                    `,
                    [req.params.id]
                );

            const rank =
                rankResult.rows[0];

            if (!rank) {
                throw new Error(
                    "Ранг не найден."
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id=$1
                    FOR UPDATE
                    `,
                    [req.user.id]
                );

            const user =
                userResult.rows[0];

            const owned =
                Array.isArray(
                    user.owned_ranks
                )
                    ? user.owned_ranks
                    : [];

            if (
                owned.includes(rank.rank_id)
            ) {
                throw new Error(
                    "Этот ранг уже куплен."
                );
            }

            const balance =
                Number(user.balance);

            const price =
                Number(rank.price);

            if (balance < price) {
                throw new Error(
                    `Не хватает ${
                        (
                            price - balance
                        ).toLocaleString("ru-RU")
                    } ₽`
                );
            }

            owned.push(rank.rank_id);

            const history =
                Array.isArray(user.history)
                    ? user.history
                    : [];

            history.push({
                type: "rank_purchase",
                title:
                    `Покупка ранга · ${rank.name}`,
                amount: -price,
                createdAt:
                    new Date().toISOString()
            });

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance = balance - $1,
                        owned_ranks = $2,
                        history = $3
                    WHERE id=$4
                    RETURNING *
                    `,
                    [
                        price,
                        JSON.stringify(owned),
                        JSON.stringify(
                            history.slice(-50)
                        ),
                        user.id
                    ]
                );

            await client.query("COMMIT");

            broadcast("leaderboard:update");

            res.json({
                user:
                    publicUser(
                        updated.rows[0]
                    ),
                rank: {
                    id: rank.id,
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

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   QUESTS
========================================================= */

app.get(
    "/api/quests",
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        quest_id,
                        title,
                        description,
                        reward,
                        xp
                    FROM quests
                    ORDER BY created_at ASC
                    `
                );

            res.json({
                quests:
                    result.rows.map(q => ({
                        id: q.id,
                        questId: q.quest_id,
                        title: q.title,
                        description:
                            q.description,
                        reward:
                            Number(q.reward),
                        xp:
                            Number(q.xp)
                    }))
            });
        } catch (error) {
            console.error(
                "QUESTS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Ошибка загрузки квестов."
            });
        }
    }
);

app.post(
    "/api/quests/:id/claim",
    auth,
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query("BEGIN");

            const questResult =
                await client.query(
                    `
                    SELECT *
                    FROM quests
                    WHERE quest_id=$1
                    LIMIT 1
                    `,
                    [req.params.id]
                );

            const quest =
                questResult.rows[0];

            if (!quest) {
                throw new Error(
                    "Квест не найден."
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id=$1
                    FOR UPDATE
                    `,
                    [req.user.id]
                );

            const user =
                userResult.rows[0];

            const claimed =
                user.claimed_quests &&
                typeof user.claimed_quests ===
                    "object"
                    ? user.claimed_quests
                    : {};

            if (claimed[quest.quest_id]) {
                throw new Error(
                    "Этот квест уже получен."
                );
            }

            claimed[quest.quest_id] = true;

            const history =
                Array.isArray(user.history)
                    ? user.history
                    : [];

            history.push({
                type: "quest_reward",
                title:
                    `Квест · ${quest.title}`,
                amount:
                    Number(quest.reward),
                xp:
                    Number(quest.xp),
                createdAt:
                    new Date().toISOString()
            });

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance =
                            balance + $1,
                        xp =
                            xp + $2,
                        claimed_quests =
                            $3,
                        history =
                            $4
                    WHERE id=$5
                    RETURNING *
                    `,
                    [
                        Number(quest.reward),
                        Number(quest.xp),
                        JSON.stringify(claimed),
                        JSON.stringify(
                            history.slice(-50)
                        ),
                        user.id
                    ]
                );

            await client.query("COMMIT");

            broadcast("leaderboard:update");

            res.json({
                user:
                    publicUser(
                        updated.rows[0]
                    ),
                reward:
                    Number(quest.reward),
                xp:
                    Number(quest.xp)
            });
        } catch (error) {
            await client.query("ROLLBACK");

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   LEADERBOARD
========================================================= */

app.get(
    "/api/leaderboard",
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        elo,
                        xp,
                        wins,
                        owned_ranks
                    FROM users
                    ORDER BY
                        elo DESC,
                        xp DESC,
                        wins DESC,
                        username ASC
                    `
                );

            res.json({
                players:
                    result.rows.map(user => ({
                        id: user.id,
                        username:
                            user.username,
                        elo:
                            Number(user.elo),
                        xp:
                            Number(user.xp),
                        wins:
                            Number(user.wins),
                        ownedRanks:
                            Array.isArray(
                                user.owned_ranks
                            )
                                ? user.owned_ranks
                                : []
                    }))
            });
        } catch (error) {
            console.error(
                "LEADERBOARD ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Ошибка рейтинга."
            });
        }
    }
);

/* =========================================================
   ADMIN - USERS
========================================================= */

app.get(
    "/api/admin/users",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const search =
                String(
                    req.query.search || ""
                ).trim();

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        email,
                        username,
                        role,
                        balance,
                        xp,
                        elo,
                        wins,
                        owned_ranks
                    FROM users
                    WHERE
                        $1 = ''
                        OR username ILIKE '%' || $1 || '%'
                        OR email ILIKE '%' || $1 || '%'
                    ORDER BY elo DESC
                    LIMIT 100
                    `,
                    [search]
                );

            res.json({
                users:
                    result.rows.map(u => ({
                        id: u.id,
                        email: u.email,
                        username:
                            u.username,
                        role: u.role,
                        balance:
                            Number(u.balance),
                        xp:
                            Number(u.xp),
                        elo:
                            Number(u.elo),
                        wins:
                            Number(u.wins),
                        ownedRanks:
                            Array.isArray(
                                u.owned_ranks
                            )
                                ? u.owned_ranks
                                : []
                    }))
            });
        } catch (error) {
            console.error(
                "ADMIN USERS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Ошибка загрузки игроков."
            });
        }
    }
);

/* =========================================================
   ADMIN - EDIT USER
========================================================= */

app.put(
    "/api/admin/users/:id",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const elo =
                Math.max(
                    0,
                    Number(
                        req.body?.elo ?? 1000
                    )
                );

            const wins =
                Math.max(
                    0,
                    Number(
                        req.body?.wins ?? 0
                    )
                );

            const balance =
                Math.max(
                    0,
                    Number(
                        req.body?.balance ?? 0
                    )
                );

            const xp =
                Math.max(
                    0,
                    Number(
                        req.body?.xp ?? 0
                    )
                );

            if (
                !Number.isFinite(elo) ||
                !Number.isFinite(wins) ||
                !Number.isFinite(balance) ||
                !Number.isFinite(xp)
            ) {
                return res.status(400).json({
                    error:
                        "Некорректные числовые значения."
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET
                        elo=$1,
                        wins=$2,
                        balance=$3,
                        xp=$4
                    WHERE id=$5
                    RETURNING *
                    `,
                    [
                        Math.floor(elo),
                        Math.floor(wins),
                        Math.floor(balance),
                        Math.floor(xp),
                        req.params.id
                    ]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }

            broadcast("leaderboard:update");

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });
        } catch (error) {
            console.error(
                "ADMIN USER UPDATE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Не удалось изменить игрока."
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE RANK
========================================================= */

app.post(
    "/api/admin/users/:id/ranks",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const rankId =
                String(
                    req.body?.rankId || ""
                ).trim();

            if (!rankId) {
                return res.status(400).json({
                    error:
                        "Не указан rankId."
                });
            }

            const rank =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE rank_id=$1
                    LIMIT 1
                    `,
                    [rankId]
                );

            if (!rank.rowCount) {
                return res.status(404).json({
                    error:
                        "Ранг не найден."
                });
            }

            const user =
                await getUserById(
                    req.params.id
                );

            if (!user) {
                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }

            const owned =
                Array.isArray(
                    user.owned_ranks
                )
                    ? user.owned_ranks
                    : [];

            if (!owned.includes(rankId)) {
                owned.push(rankId);
            }

            const updated =
                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks=$1
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(owned),
                        user.id
                    ]
                );

            res.json({
                user:
                    publicUser(
                        updated.rows[0]
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось выдать ранг."
            });
        }
    }
);

/* =========================================================
   ADMIN - REMOVE RANK
========================================================= */

app.delete(
    "/api/admin/users/:id/ranks/:rankId",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const user =
                await getUserById(
                    req.params.id
                );

            if (!user) {
                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }

            const owned =
                Array.isArray(
                    user.owned_ranks
                )
                    ? user.owned_ranks
                    : [];

            const newOwned =
                owned.filter(
                    id =>
                        id !==
                        req.params.rankId
                );

            const updated =
                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks=$1
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(
                            newOwned
                        ),
                        user.id
                    ]
                );

            res.json({
                user:
                    publicUser(
                        updated.rows[0]
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось снять ранг."
            });
        }
    }
);

/* =========================================================
   ADMIN - RANKS
========================================================= */

app.get(
    "/api/admin/ranks",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    ORDER BY created_at ASC
                    `
                );

            res.json({
                ranks:
                    result.rows.map(r => ({
                        id: r.id,
                        rankId: r.rank_id,
                        name: r.name,
                        title: r.title,
                        price:
                            Number(r.price),
                        color: r.color,
                        icon: r.icon
                    }))
            });
        } catch (error) {
            res.status(500).json({
                error:
                    "Ошибка админских рангов."
            });
        }
    }
);

app.post(
    "/api/admin/ranks",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const rankId =
                String(
                    req.body?.rankId || ""
                ).trim();

            const name =
                String(
                    req.body?.name || ""
                ).trim();

            const title =
                String(
                    req.body?.title || ""
                ).trim();

            const price =
                Number(
                    req.body?.price || 0
                );

            const color =
                String(
                    req.body?.color ||
                    "#9b6cff"
                ).trim();

            const icon =
                String(
                    req.body?.icon || "★"
                ).trim();

            if (!rankId || !name) {
                return res.status(400).json({
                    error:
                        "ID и название ранга обязательны."
                });
            }

            if (
                !Number.isFinite(price) ||
                price < 0
            ) {
                return res.status(400).json({
                    error:
                        "Некорректная цена."
                });
            }

            const result =
                await pool.query(
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
                    ($1,$2,$3,$4,$5,$6)
                    RETURNING *
                    `,
                    [
                        rankId,
                        name,
                        title,
                        Math.floor(price),
                        color,
                        icon
                    ]
                );

            broadcast("ranks:update");

            res.json({
                rank: {
                    id:
                        result.rows[0].id,
                    rankId:
                        result.rows[0].rank_id,
                    name:
                        result.rows[0].name,
                    title:
                        result.rows[0].title,
                    price:
                        Number(
                            result.rows[0].price
                        ),
                    color:
                        result.rows[0].color,
                    icon:
                        result.rows[0].icon
                }
            });
        } catch (error) {
            console.error(
                "CREATE RANK ERROR:",
                error
            );

            if (
                error.code === "23505"
            ) {
                return res.status(409).json({
                    error:
                        "Такой ID ранга уже существует."
                });
            }

            res.status(500).json({
                error:
                    "Не удалось создать ранг."
            });
        }
    }
);

app.delete(
    "/api/admin/ranks/:id",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    DELETE FROM ranks
                    WHERE rank_id=$1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Ранг не найден."
                });
            }

            broadcast("ranks:update");

            res.json({
                success: true
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось удалить ранг."
            });
        }
    }
);

/* =========================================================
   ADMIN - QUESTS
========================================================= */

app.get(
    "/api/admin/quests",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM quests
                    ORDER BY created_at ASC
                    `
                );

            res.json({
                quests:
                    result.rows.map(q => ({
                        id: q.id,
                        questId:
                            q.quest_id,
                        title:
                            q.title,
                        description:
                            q.description,
                        reward:
                            Number(q.reward),
                        xp:
                            Number(q.xp)
                    }))
            });
        } catch (error) {
            res.status(500).json({
                error:
                    "Ошибка админских квестов."
            });
        }
    }
);

app.post(
    "/api/admin/quests",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const questId =
                String(
                    req.body?.questId || ""
                ).trim();

            const title =
                String(
                    req.body?.title || ""
                ).trim();

            const description =
                String(
                    req.body?.description || ""
                ).trim();

            const reward =
                Number(
                    req.body?.reward || 0
                );

            const xp =
                Number(
                    req.body?.xp || 0
                );

            if (!questId || !title) {
                return res.status(400).json({
                    error:
                        "ID и название квеста обязательны."
                });
            }

            if (
                !Number.isFinite(reward) ||
                reward < 0 ||
                !Number.isFinite(xp) ||
                xp < 0
            ) {
                return res.status(400).json({
                    error:
                        "Некорректная награда или XP."
                });
            }

            const result =
                await pool.query(
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
                    ($1,$2,$3,$4,$5)
                    RETURNING *
                    `,
                    [
                        questId,
                        title,
                        description,
                        Math.floor(reward),
                        Math.floor(xp)
                    ]
                );

            broadcast("quests:update");

            res.json({
                quest: {
                    id:
                        result.rows[0].id,
                    questId:
                        result.rows[0].quest_id,
                    title:
                        result.rows[0].title,
                    description:
                        result.rows[0].description,
                    reward:
                        Number(
                            result.rows[0].reward
                        ),
                    xp:
                        Number(
                            result.rows[0].xp
                        )
                }
            });
        } catch (error) {
            console.error(
                "CREATE QUEST ERROR:",
                error
            );

            if (
                error.code === "23505"
            ) {
                return res.status(409).json({
                    error:
                        "Такой ID квеста уже существует."
                });
            }

            res.status(500).json({
                error:
                    "Не удалось создать квест."
            });
        }
    }
);

app.delete(
    "/api/admin/quests/:id",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    DELETE FROM quests
                    WHERE quest_id=$1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Квест не найден."
                });
            }

            broadcast("quests:update");

            res.json({
                success: true
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось удалить квест."
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE ELO / WINS / MONEY
========================================================= */

app.post(
    "/api/admin/users/:id/give",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const elo =
                Number(
                    req.body?.elo || 0
                );

            const wins =
                Number(
                    req.body?.wins || 0
                );

            const balance =
                Number(
                    req.body?.balance || 0
                );

            const xp =
                Number(
                    req.body?.xp || 0
                );

            if (
                ![elo,wins,balance,xp]
                    .every(Number.isFinite)
            ) {
                return res.status(400).json({
                    error:
                        "Некорректные значения."
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET
                        elo =
                            GREATEST(0, elo + $1),
                        wins =
                            GREATEST(0, wins + $2),
                        balance =
                            GREATEST(0, balance + $3),
                        xp =
                            GREATEST(0, xp + $4)
                    WHERE id=$5
                    RETURNING *
                    `,
                    [
                        Math.floor(elo),
                        Math.floor(wins),
                        Math.floor(balance),
                        Math.floor(xp),
                        req.params.id
                    ]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }

            broadcast("leaderboard:update");

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось выдать награды."
            });
        }
    }
);

/* =========================================================
   ADMIN - MAKE USER ADMIN
========================================================= */

app.post(
    "/api/admin/users/:id/admin",
    auth,
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET role='admin'
                    WHERE id=$1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });
        } catch (error) {
            res.status(500).json({
                error:
                    "Не удалось выдать права администратора."
            });
        }
    }
);

/* =========================================================
   CREATE DEFAULT ADMIN
========================================================= */

async function ensureAdmin() {
    try {
        const existing =
            await pool.query(
                `
                SELECT *
                FROM users
                WHERE lower(email)=lower($1)
                LIMIT 1
                `,
                [ADMIN_EMAIL]
            );

        if (existing.rowCount > 0) {
            const user =
                existing.rows[0];

            if (user.role !== "admin") {
                await pool.query(
                    `
                    UPDATE users
                    SET role='admin'
                    WHERE id=$1
                    `,
                    [user.id]
                );

                console.log(
                    "✅ Existing admin promoted:",
                    ADMIN_EMAIL
                );
            } else {
                console.log(
                    "✅ Admin exists:",
                    ADMIN_EMAIL
                );
            }

            return;
        }

        const hash =
            await bcrypt.hash(
                ADMIN_PASSWORD,
                12
            );

        await pool.query(
            `
            INSERT INTO users
            (
                email,
                username,
                password_hash,
                role,
                balance,
                elo,
                wins
            )
            VALUES
            ($1,$2,$3,'admin',1000000,9999,999)
            `,
            [
                ADMIN_EMAIL,
                "ASTRO_ADMIN",
                hash
            ]
        );

        console.log("");
        console.log(
            "========================================"
        );
        console.log(
            "✅ ADMIN CREATED"
        );
        console.log(
            "Email:",
            ADMIN_EMAIL
        );
        console.log(
            "Password:",
            ADMIN_PASSWORD
        );
        console.log(
            "========================================"
        );
        console.log("");
    } catch (error) {
        console.error(
            "ADMIN ERROR:",
            error
        );
    }
}

/* =========================================================
   SOCKET
========================================================= */

io.on("connection", socket => {
    console.log(
        "🔌 Socket connected:",
        socket.id
    );

    socket.on("disconnect", () => {
        console.log(
            "🔌 Socket disconnected:",
            socket.id
        );
    });
});

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.use((req, res, next) => {
    if (
        req.method === "GET" &&
        !req.path.startsWith("/api/")
    ) {
        return res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );
    }

    next();
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
    console.error(
        "UNHANDLED ERROR:",
        error
    );

    res.status(500).json({
        error:
            "Внутренняя ошибка сервера."
    });
});

/* =========================================================
   START
========================================================= */

async function start() {
    try {
        await initDatabase();

        await ensureAdmin();

        server.listen(
            PORT,
            () => {
                console.log("");
                console.log(
                    "🚀 =================================="
                );
                console.log(
                    "🚀 ASTRO ONLINE запущен"
                );
                console.log(
                    `🚀 Порт: ${PORT}`
                );
                console.log(
                    `🚀 http://localhost:${PORT}`
                );
                console.log(
                    "🚀 =================================="
                );
                console.log("");
            }
        );
    } catch (error) {
        console.error("");
        console.error(
            "❌ НЕ УДАЛОСЬ ЗАПУСТИТЬ ASTRO:"
        );
        console.error(error);
        console.error("");
        process.exit(1);
    }
}

start();
