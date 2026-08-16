```javascript
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
    process.env.JWT_SECRET ||
    "astro-super-secret-change-me";

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL ||
    "admin@astro.online";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    "admin12345";

if (!DATABASE_URL) {
    console.error("DATABASE_URL не указан.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT UNIQUE NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,

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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            rank_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            title TEXT NOT NULL,
            price BIGINT NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#8b5cf6',
            icon TEXT NOT NULL DEFAULT '★',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
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
      Старые версии проекта могли создать ranks
      с другими колонками. Добавляем недостающие.
    */

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS rank_id TEXT
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS name TEXT
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS title TEXT
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS price BIGINT DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#8b5cf6'
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '★'
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS quest_id TEXT
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS title TEXT
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS reward BIGINT DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS xp BIGINT DEFAULT 0
    `);

    /* Дефолтные ранги */

    const rankCount = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM ranks
        WHERE rank_id IS NOT NULL
    `);

    if (rankCount.rows[0].count === 0) {
        const ranks = [
            ["bronze", "BRONZE", "Бронзовый", 5000, "#cd7f32", "◆"],
            ["silver", "SILVER", "Серебряный", 15000, "#b9c3d0", "◇"],
            ["gold", "GOLD", "Золотой", 35000, "#ffd45a", "✦"],
            ["diamond", "DIAMOND", "Алмазный", 75000, "#6ee7ff", "✧"],
            ["master", "MASTER", "Мастер", 150000, "#c084fc", "✹"],
            ["astro", "ASTRO", "ASTRO ELITE", 300000, "#ff6bd6", "★"]
        ];

        for (const r of ranks) {
            await pool.query(`
                INSERT INTO ranks
                (rank_id,name,title,price,color,icon)
                VALUES($1,$2,$3,$4,$5,$6)
                ON CONFLICT(rank_id) DO NOTHING
            `, r);
        }
    }

    /* Дефолтные квесты */

    const questCount = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM quests
        WHERE quest_id IS NOT NULL
    `);

    if (questCount.rows[0].count === 0) {
        const quests = [
            [
                "daily-login",
                "Войти в систему",
                "Открой профиль и забери ежедневную награду.",
                50,
                25
            ],
            [
                "daily-explore",
                "Исследователь",
                "Посети разделы ASTRO и изучи новый сезон.",
                100,
                50
            ],
            [
                "daily-elite",
                "Elite Protocol",
                "Выполни особое задание сезона.",
                250,
                100
            ]
        ];

        for (const q of quests) {
            await pool.query(`
                INSERT INTO quests
                (quest_id,title,description,reward,xp)
                VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(quest_id) DO NOTHING
            `, q);
        }
    }

    /* Создание стандартного админа */

    const adminExists = await pool.query(`
        SELECT id
        FROM users
        WHERE lower(email)=lower($1)
        LIMIT 1
    `, [ADMIN_EMAIL]);

    if (adminExists.rowCount === 0) {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

        await pool.query(`
            INSERT INTO users
            (email,username,password_hash,balance,elo,wins)
            VALUES($1,$2,$3,999999999,999999,999)
        `, [
            ADMIN_EMAIL,
            "ASTRO_ADMIN",
            hash
        ]);

        console.log("Создан админ:");
        console.log("Email:", ADMIN_EMAIL);
        console.log("Password:", ADMIN_PASSWORD);
    }

    console.log("ASTRO DATABASE READY");
}

/* =========================================================
   HELPERS
========================================================= */

function publicUser(u) {
    return {
        id: u.id,
        email: u.email,
        username: u.username,

        balance: Number(u.balance || 0),
        xp: Number(u.xp || 0),
        elo: Number(u.elo || 0),
        wins: Number(u.wins || 0),

        ownedRanks: u.owned_ranks || [],
        claimedQuests: u.claimed_quests || {},
        history: u.history || [],

        createdAt: u.created_at,
        lastLoginAt: u.last_login_at
    };
}

function tokenFor(user) {
    return jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: "30d" }
    );
}

function broadcastAll() {
    io.emit("leaderboard:update");
    io.emit("ranks:update");
    io.emit("quests:update");
}

async function auth(req, res, next) {
    try {
        const header = req.headers.authorization || "";

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

        const result = await pool.query(
            "SELECT * FROM users WHERE id=$1",
            [payload.id]
        );

        if (!result.rows[0]) {
            return res.status(401).json({
                error: "Пользователь не найден."
            });
        }

        req.user = result.rows[0];

        next();

    } catch (error) {
        return res.status(401).json({
            error: "Сессия недействительна."
        });
    }
}

async function adminAuth(req, res, next) {
    await auth(req, res, async () => {
        try {
            const isAdmin =
                req.user.email.toLowerCase() ===
                ADMIN_EMAIL.toLowerCase();

            if (!isAdmin) {
                return res.status(403).json({
                    error: "Доступ только для администратора."
                });
            }

            next();

        } catch (error) {
            return res.status(403).json({
                error: "Нет доступа."
            });
        }
    });
}

function normalizeRank(row) {
    return {
        id: row.id,
        rankId: row.rank_id,
        name: row.name,
        title: row.title,
        price: Number(row.price || 0),
        color: row.color || "#8b5cf6",
        icon: row.icon || "★"
    };
}

function normalizeQuest(row) {
    return {
        id: row.id,
        questId: row.quest_id,
        title: row.title,
        description: row.description || "",
        reward: Number(row.reward || 0),
        xp: Number(row.xp || 0)
    };
}

/*
  Определяем самый высокий ранг игрока.
  Порядок берётся из цены.
*/

async function getPlayerRank(ownedRanks) {
    if (!Array.isArray(ownedRanks) || ownedRanks.length === 0) {
        return null;
    }

    const result = await pool.query(`
        SELECT *
        FROM ranks
        WHERE rank_id = ANY($1::text[])
        ORDER BY price DESC
        LIMIT 1
    `, [ownedRanks]);

    if (!result.rows[0]) {
        return null;
    }

    return normalizeRank(result.rows[0]);
}

async function userWithRank(user) {
    const result = await pool.query(
        "SELECT * FROM users WHERE id=$1",
        [user.id]
    );

    const fresh = result.rows[0];

    const rank = await getPlayerRank(
        fresh.owned_ranks || []
    );

    return {
        ...publicUser(fresh),
        rank
    };
}

/* =========================================================
   BASIC
========================================================= */

app.get("/api/me", auth, async (req, res) => {
    try {
        res.json({
            user: await userWithRank(req.user)
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка профиля."
        });
    }
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const {
            username,
            email,
            password
        } = req.body || {};

        const e =
            String(email || "")
                .trim()
                .toLowerCase();

        const n =
            String(username || "")
                .trim();

        const p =
            String(password || "");

        if (!/^\S+@\S+\.\S+$/.test(e)) {
            return res.status(400).json({
                error: "Введите корректный email."
            });
        }

        if (!/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(n)) {
            return res.status(400).json({
                error: "Никнейм: 3–20 символов."
            });
        }

        if (p.length < 8) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 8 символов."
            });
        }

        const exists = await pool.query(`
            SELECT id
            FROM users
            WHERE lower(email)=lower($1)
               OR lower(username)=lower($2)
            LIMIT 1
        `, [e, n]);

        if (exists.rowCount) {
            return res.status(409).json({
                error: "Email или никнейм уже занят."
            });
        }

        const hash =
            await bcrypt.hash(p, 12);

        const result = await pool.query(`
            INSERT INTO users
            (email,username,password_hash)
            VALUES($1,$2,$3)
            RETURNING *
        `, [e, n, hash]);

        const user = result.rows[0];

        broadcastAll();

        res.json({
            token: tokenFor(user),
            user: await userWithRank(user)
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Не удалось создать аккаунт."
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
    try {
        const {
            email,
            password
        } = req.body || {};

        const result = await pool.query(`
            SELECT *
            FROM users
            WHERE lower(email)=lower($1)
            LIMIT 1
        `, [
            String(email || "").trim()
        ]);

        const user = result.rows[0];

        if (
            !user ||
            !(await bcrypt.compare(
                String(password || ""),
                user.password_hash
            ))
        ) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        await pool.query(`
            UPDATE users
            SET last_login_at=now()
            WHERE id=$1
        `, [user.id]);

        const fresh =
            (await pool.query(
                "SELECT * FROM users WHERE id=$1",
                [user.id]
            )).rows[0];

        res.json({
            token: tokenFor(fresh),
            user: await userWithRank(fresh)
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка входа."
        });
    }
});

/* =========================================================
   RANKS
========================================================= */

app.get("/api/ranks", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM ranks
            ORDER BY price ASC, created_at ASC
        `);

        res.json({
            ranks: result.rows.map(normalizeRank)
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка загрузки рангов."
        });
    }
});

/* =========================================================
   BUY RANK
========================================================= */

app.post(
    "/api/ranks/:id/buy",
    auth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {
            await client.query("BEGIN");

            const rankResult =
                await client.query(`
                    SELECT *
                    FROM ranks
                    WHERE rank_id=$1
                    FOR UPDATE
                `, [req.params.id]);

            const rank =
                rankResult.rows[0];

            if (!rank) {
                throw new Error(
                    "Ранг не найден."
                );
            }

            const userResult =
                await client.query(`
                    SELECT *
                    FROM users
                    WHERE id=$1
                    FOR UPDATE
                `, [req.user.id]);

            const user =
                userResult.rows[0];

            const owned =
                Array.isArray(user.owned_ranks)
                    ? [...user.owned_ranks]
                    : [];

            if (owned.includes(rank.rank_id)) {
                throw new Error(
                    "Этот ранг уже куплен."
                );
            }

            const price =
                Number(rank.price || 0);

            const balance =
                Number(user.balance || 0);

            if (balance < price) {
                throw new Error(
                    `Не хватает ${(price - balance).toLocaleString("ru-RU")} ₽`
                );
            }

            owned.push(rank.rank_id);

            const history = [
                ...(user.history || []),
                {
                    title:
                        `Покупка ранга · ${rank.name}`,
                    amount: -price,
                    createdAt:
                        new Date().toISOString()
                }
            ].slice(-30);

            const updated =
                await client.query(`
                    UPDATE users
                    SET
                        balance=balance-$1,
                        owned_ranks=$2::jsonb,
                        history=$3::jsonb
                    WHERE id=$4
                    RETURNING *
                `, [
                    price,
                    JSON.stringify(owned),
                    JSON.stringify(history),
                    user.id
                ]);

            await client.query("COMMIT");

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        updated.rows[0]
                    ),
                rank:
                    normalizeRank(rank)
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

app.get("/api/quests", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM quests
            ORDER BY created_at ASC
        `);

        res.json({
            quests: result.rows.map(normalizeQuest)
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка загрузки квестов."
        });
    }
});

/* =========================================================
   CLAIM QUEST
========================================================= */

app.post(
    "/api/quests/:id/claim",
    auth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {
            await client.query("BEGIN");

            const questResult =
                await client.query(`
                    SELECT *
                    FROM quests
                    WHERE quest_id=$1
                    FOR UPDATE
                `, [req.params.id]);

            const quest =
                questResult.rows[0];

            if (!quest) {
                throw new Error(
                    "Квест не найден."
                );
            }

            const userResult =
                await client.query(`
                    SELECT *
                    FROM users
                    WHERE id=$1
                    FOR UPDATE
                `, [req.user.id]);

            const user =
                userResult.rows[0];

            const claimed =
                user.claimed_quests || {};

            if (claimed[quest.quest_id]) {
                throw new Error(
                    "Этот квест уже получен."
                );
            }

            claimed[quest.quest_id] = true;

            const reward =
                Number(quest.reward || 0);

            const xp =
                Number(quest.xp || 0);

            const history = [
                ...(user.history || []),
                {
                    title:
                        `Квест · ${quest.title}`,
                    amount: reward,
                    createdAt:
                        new Date().toISOString()
                }
            ].slice(-30);

            const updated =
                await client.query(`
                    UPDATE users
                    SET
                        balance=balance+$1,
                        xp=xp+$2,
                        claimed_quests=$3::jsonb,
                        history=$4::jsonb
                    WHERE id=$5
                    RETURNING *
                `, [
                    reward,
                    xp,
                    JSON.stringify(claimed),
                    JSON.stringify(history),
                    user.id
                ]);

            await client.query("COMMIT");

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        updated.rows[0]
                    ),
                reward,
                xp
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
            const result = await pool.query(`
                SELECT
                    id,
                    username,
                    balance,
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
            `);

            const players =
                await Promise.all(
                    result.rows.map(async user => ({
                        id: user.id,
                        username: user.username,

                        balance:
                            Number(user.balance || 0),

                        elo:
                            Number(user.elo || 0),

                        xp:
                            Number(user.xp || 0),

                        wins:
                            Number(user.wins || 0),

                        ownedRanks:
                            user.owned_ranks || [],

                        rank:
                            await getPlayerRank(
                                user.owned_ranks || []
                            )
                    }))
                );

            res.json({
                players
            });

        } catch (error) {
            console.error("LEADERBOARD ERROR:", error);

            res.status(500).json({
                error: "Ошибка рейтинга."
            });
        }
    }
);

/* =========================================================
   ADMIN USERS
========================================================= */

app.get(
    "/api/admin/users",
    adminAuth,
    async (req, res) => {

        try {
            const search =
                String(
                    req.query.search || ""
                ).trim();

            const result =
                await pool.query(`
                    SELECT
                        id,
                        email,
                        username,
                        balance,
                        elo,
                        xp,
                        wins,
                        owned_ranks
                    FROM users
                    WHERE
                        username ILIKE $1
                        OR email ILIKE $1
                    ORDER BY elo DESC
                    LIMIT 100
                `, [`%${search}%`]);

            res.json({
                users:
                    result.rows.map(u => ({
                        id: u.id,
                        email: u.email,
                        username: u.username,
                        balance: Number(u.balance || 0),
                        elo: Number(u.elo || 0),
                        xp: Number(u.xp || 0),
                        wins: Number(u.wins || 0),
                        ownedRanks: u.owned_ranks || []
                    }))
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка загрузки игроков."
            });
        }
    }
);

/* =========================================================
   ADMIN UPDATE PLAYER
========================================================= */

app.put(
    "/api/admin/users/:id",
    adminAuth,
    async (req, res) => {

        try {
            const elo =
                Math.max(
                    0,
                    Number(req.body.elo || 0)
                );

            const wins =
                Math.max(
                    0,
                    Number(req.body.wins || 0)
                );

            const balance =
                Math.max(
                    0,
                    Number(req.body.balance || 0)
                );

            const xp =
                Math.max(
                    0,
                    Number(req.body.xp || 0)
                );

            const result =
                await pool.query(`
                    UPDATE users
                    SET
                        elo=$1,
                        wins=$2,
                        balance=$3,
                        xp=$4
                    WHERE id=$5
                    RETURNING *
                `, [
                    elo,
                    wins,
                    balance,
                    xp,
                    req.params.id
                ]);

            if (!result.rows[0]) {
                return res.status(404).json({
                    error: "Игрок не найден."
                });
            }

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        result.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Не удалось сохранить игрока."
            });
        }
    }
);

/* =========================================================
   ADMIN GIVE ELO
========================================================= */

app.post(
    "/api/admin/users/:id/elo",
    adminAuth,
    async (req, res) => {

        try {
            const amount =
                Number(req.body.amount || 0);

            const result =
                await pool.query(`
                    UPDATE users
                    SET elo=GREATEST(0,elo+$1)
                    WHERE id=$2
                    RETURNING *
                `, [
                    amount,
                    req.params.id
                ]);

            if (!result.rows[0]) {
                return res.status(404).json({
                    error: "Игрок не найден."
                });
            }

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        result.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка изменения ELO."
            });
        }
    }
);

/* =========================================================
   ADMIN GIVE WINS
========================================================= */

app.post(
    "/api/admin/users/:id/wins",
    adminAuth,
    async (req, res) => {

        try {
            const amount =
                Number(req.body.amount || 0);

            const result =
                await pool.query(`
                    UPDATE users
                    SET wins=GREATEST(0,wins+$1)
                    WHERE id=$2
                    RETURNING *
                `, [
                    amount,
                    req.params.id
                ]);

            if (!result.rows[0]) {
                return res.status(404).json({
                    error: "Игрок не найден."
                });
            }

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        result.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка изменения побед."
            });
        }
    }
);

/* =========================================================
   ADMIN RANKS
========================================================= */

app.get(
    "/api/admin/ranks",
    adminAuth,
    async (req, res) => {

        try {
            const result =
                await pool.query(`
                    SELECT *
                    FROM ranks
                    ORDER BY price ASC
                `);

            res.json({
                ranks:
                    result.rows.map(normalizeRank)
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка админских рангов."
            });
        }
    }
);

/* CREATE RANK */

app.post(
    "/api/admin/ranks",
    adminAuth,
    async (req, res) => {

        try {
            const rankId =
                String(
                    req.body.rankId || ""
                ).trim();

            const name =
                String(
                    req.body.name || ""
                ).trim();

            const title =
                String(
                    req.body.title || ""
                ).trim();

            const price =
                Math.max(
                    0,
                    Number(req.body.price || 0)
                );

            const color =
                String(
                    req.body.color || "#8b5cf6"
                );

            const icon =
                String(
                    req.body.icon || "★"
                );

            if (!rankId || !name || !title) {
                return res.status(400).json({
                    error:
                        "Заполните ID, название и титул."
                });
            }

            const result =
                await pool.query(`
                    INSERT INTO ranks
                    (rank_id,name,title,price,color,icon)
                    VALUES($1,$2,$3,$4,$5,$6)
                    RETURNING *
                `, [
                    rankId,
                    name,
                    title,
                    price,
                    color,
                    icon
                ]);

            broadcastAll();

            res.json({
                rank:
                    normalizeRank(
                        result.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            if (error.code === "23505") {
                return res.status(409).json({
                    error:
                        "Такой ID ранга уже существует."
                });
            }

            res.status(500).json({
                error: "Не удалось создать ранг."
            });
        }
    }
);

/* DELETE RANK */

app.delete(
    "/api/admin/ranks/:id",
    adminAuth,
    async (req, res) => {

        try {
            const result =
                await pool.query(`
                    DELETE FROM ranks
                    WHERE rank_id=$1
                    RETURNING *
                `, [req.params.id]);

            if (!result.rows[0]) {
                return res.status(404).json({
                    error: "Ранг не найден."
                });
            }

            /*
              Убираем удалённый ранг
              у всех пользователей.
            */

            const rankId =
                result.rows[0].rank_id;

            await pool.query(`
                UPDATE users
                SET owned_ranks =
                    COALESCE(
                        (
                            SELECT jsonb_agg(x)
                            FROM jsonb_array_elements(
                                owned_ranks
                            ) x
                            WHERE x #>> '{}' <> $1
                        ),
                        '[]'::jsonb
                    )
            `, [rankId]);

            broadcastAll();

            res.json({
                success: true
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Не удалось удалить ранг."
            });
        }
    }
);

/* GIVE RANK */

app.post(
    "/api/admin/users/:id/ranks/:rankId",
    adminAuth,
    async (req, res) => {

        try {
            const rank =
                await pool.query(`
                    SELECT *
                    FROM ranks
                    WHERE rank_id=$1
                `, [req.params.rankId]);

            if (!rank.rows[0]) {
                return res.status(404).json({
                    error: "Ранг не найден."
                });
            }

            const user =
                await pool.query(`
                    SELECT *
                    FROM users
                    WHERE id=$1
                `, [req.params.id]);

            if (!user.rows[0]) {
                return res.status(404).json({
                    error: "Игрок не найден."
                });
            }

            const owned =
                Array.isArray(
                    user.rows[0].owned_ranks
                )
                    ? [...user.rows[0].owned_ranks]
                    : [];

            if (!owned.includes(req.params.rankId)) {
                owned.push(req.params.rankId);
            }

            const updated =
                await pool.query(`
                    UPDATE users
                    SET owned_ranks=$1::jsonb
                    WHERE id=$2
                    RETURNING *
                `, [
                    JSON.stringify(owned),
                    req.params.id
                ]);

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        updated.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Не удалось выдать ранг."
            });
        }
    }
);

/* REMOVE RANK */

app.delete(
    "/api/admin/users/:id/ranks/:rankId",
    adminAuth,
    async (req, res) => {

        try {
            const user =
                await pool.query(`
                    SELECT *
                    FROM users
                    WHERE id=$1
                `, [req.params.id]);

            if (!user.rows[0]) {
                return res.status(404).json({
                    error: "Игрок не найден."
                });
            }

            const owned =
                Array.isArray(
                    user.rows[0].owned_ranks
                )
                    ? user.rows[0].owned_ranks
                    : [];

            const filtered =
                owned.filter(
                    x => x !== req.params.rankId
                );

            const updated =
                await pool.query(`
                    UPDATE users
                    SET owned_ranks=$1::jsonb
                    WHERE id=$2
                    RETURNING *
                `, [
                    JSON.stringify(filtered),
                    req.params.id
                ]);

            broadcastAll();

            res.json({
                user:
                    await userWithRank(
                        updated.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Не удалось снять ранг."
            });
        }
    }
);

/* =========================================================
   ADMIN QUESTS
========================================================= */

app.get(
    "/api/admin/quests",
    adminAuth,
    async (req, res) => {

        try {
            const result =
                await pool.query(`
                    SELECT *
                    FROM quests
                    ORDER BY created_at ASC
                `);

            res.json({
                quests:
                    result.rows.map(normalizeQuest)
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка админских квестов."
            });
        }
    }
);

/* CREATE QUEST */

app.post(
    "/api/admin/quests",
    adminAuth,
    async (req, res) => {

        try {
            const questId =
                String(
                    req.body.questId || ""
                ).trim();

            const title =
                String(
                    req.body.title || ""
                ).trim();

            const description =
                String(
                    req.body.description || ""
                ).trim();

            const reward =
                Math.max(
                    0,
                    Number(req.body.reward || 0)
                );

            const xp =
                Math.max(
                    0,
                    Number(req.body.xp || 0)
                );

            if (!questId || !title) {
                return res.status(400).json({
                    error:
                        "Заполните ID и название квеста."
                });
            }

            const result =
                await pool.query(`
                    INSERT INTO quests
                    (quest_id,title,description,reward,xp)
                    VALUES($1,$2,$3,$4,$5)
                    RETURNING *
                `, [
                    questId,
                    title,
                    description,
                    reward,
                    xp
                ]);

            broadcastAll();

            res.json({
                quest:
                    normalizeQuest(
                        result.rows[0]
                    )
            });

        } catch (error) {
            console.error(error);

            if (error.code === "23505") {
                return res.status(409).json({
                    error:
                        "Такой ID квеста уже существует."
                });
            }

            res.status(500).json({
                error: "Не удалось создать квест."
            });
        }
    }
);

/* DELETE QUEST */

app.delete(
    "/api/admin/quests/:id",
    adminAuth,
    async (req, res) => {

        try {
            const result =
                await pool.query(`
                    DELETE FROM quests
                    WHERE quest_id=$1
                    RETURNING *
                `, [req.params.id]);

            if (!result.rows[0]) {
                return res.status(404).json({
                    error: "Квест не найден."
                });
            }

            broadcastAll();

            res.json({
                success: true
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Не удалось удалить квест."
            });
        }
    }
);

/* =========================================================
   FRONTEND
========================================================= */

app.get("*", (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );
});

/* =========================================================
   START
========================================================= */

initDatabase()
    .then(() => {
        server.listen(
            PORT,
            () => {
                console.log(
                    `ASTRO ONLINE listening on :${PORT}`
                );
            }
        );
    })
    .catch(error => {
        console.error(
            "FATAL SERVER ERROR:"
        );

        console.error(error);

        process.exit(1);
    });
```
