```js
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
    "astro-online-secret-change-me";

const ADMIN_EMAIL =
    String(process.env.ADMIN_EMAIL || "admin@astro.local")
        .trim()
        .toLowerCase();

const ADMIN_PASSWORD =
    String(process.env.ADMIN_PASSWORD || "admin12345");

if (!DATABASE_URL) {
    console.error("DATABASE_URL is missing.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
    console.log("ASTRO: initializing database...");

    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto
    `);

    /*
       USERS
    */

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

    /*
       SAFE MIGRATION:
       если старая таблица users уже существует,
       недостающие поля будут добавлены.
    */

    const userColumns = [
        ["balance", "BIGINT NOT NULL DEFAULT 1000"],
        ["xp", "BIGINT NOT NULL DEFAULT 0"],
        ["elo", "BIGINT NOT NULL DEFAULT 1000"],
        ["wins", "BIGINT NOT NULL DEFAULT 0"],
        ["owned_ranks", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
        ["claimed_quests", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
        ["history", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT now()"],
        ["last_login_at", "TIMESTAMPTZ NOT NULL DEFAULT now()"]
    ];

    for (const [column, type] of userColumns) {
        await pool.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS ${column} ${type}
        `);
    }

    /*
       RANKS
    */

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

    /*
       QUESTS
    */

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
       ADMIN LOG
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            admin_email TEXT NOT NULL,
            action TEXT NOT NULL,
            target_user UUID,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,

            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    /*
       DEFAULT RANKS
    */

    const defaultRanks = [
        {
            id: "bronze",
            name: "BRONZE",
            title: "Бронзовый",
            price: 5000,
            color: "#cd7f32",
            icon: "◆"
        },
        {
            id: "silver",
            name: "SILVER",
            title: "Серебряный",
            price: 15000,
            color: "#b9c3d0",
            icon: "◇"
        },
        {
            id: "gold",
            name: "GOLD",
            title: "Золотой",
            price: 35000,
            color: "#ffd45a",
            icon: "✦"
        },
        {
            id: "diamond",
            name: "DIAMOND",
            title: "Алмазный",
            price: 75000,
            color: "#6ee7ff",
            icon: "✧"
        },
        {
            id: "master",
            name: "MASTER",
            title: "Мастер",
            price: 150000,
            color: "#c084fc",
            icon: "✹"
        },
        {
            id: "astro",
            name: "ASTRO",
            title: "ASTRO ELITE",
            price: 300000,
            color: "#ff6bd6",
            icon: "★"
        }
    ];

    for (const rank of defaultRanks) {
        await pool.query(
            `
            INSERT INTO ranks
                (rank_id,name,title,price,color,icon)
            VALUES
                ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (rank_id) DO NOTHING
            `,
            [
                rank.id,
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
            id: "daily-login",
            title: "Войти в систему",
            description: "Открой профиль и забери ежедневную награду.",
            reward: 50,
            xp: 25
        },
        {
            id: "daily-explore",
            title: "Исследователь",
            description: "Посети разделы ASTRO и изучи новый сезон.",
            reward: 100,
            xp: 50
        },
        {
            id: "daily-elite",
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
                (quest_id,title,description,reward,xp)
            VALUES
                ($1,$2,$3,$4,$5)
            ON CONFLICT (quest_id) DO NOTHING
            `,
            [
                quest.id,
                quest.title,
                quest.description,
                quest.reward,
                quest.xp
            ]
        );
    }

    /*
       ADMIN ACCOUNT
    */

    const adminExists = await pool.query(
        `
        SELECT id
        FROM users
        WHERE lower(email)=lower($1)
        LIMIT 1
        `,
        [ADMIN_EMAIL]
    );

    if (!adminExists.rows.length) {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

        await pool.query(
            `
            INSERT INTO users
                (
                    email,
                    username,
                    password_hash,
                    balance,
                    xp,
                    elo,
                    wins
                )
            VALUES
                ($1,$2,$3,999999999,999999,999999,999999)
            `,
            [
                ADMIN_EMAIL,
                "ASTRO_ADMIN",
                hash
            ]
        );

        console.log("ASTRO: admin account created.");
    } else {
        console.log("ASTRO: admin account already exists.");
    }

    console.log("ASTRO: database ready.");
}

/* =========================================================
   HELPERS
========================================================= */

function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        username: user.username,

        balance: Number(user.balance || 0),
        xp: Number(user.xp || 0),
        elo: Number(user.elo || 0),
        wins: Number(user.wins || 0),

        ownedRanks: user.owned_ranks || [],
        claimedQuests: user.claimed_quests || {},
        history: user.history || [],

        createdAt: user.created_at,
        lastLoginAt: user.last_login_at
    };
}

function tokenFor(user) {
    return jwt.sign(
        {
            id: user.id
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );
}

function isAdminUser(user) {
    return (
        user &&
        String(user.email).toLowerCase() === ADMIN_EMAIL
    );
}

function sendError(res, status, message) {
    return res.status(status).json({
        error: message
    });
}

function broadcastAll() {
    io.emit("leaderboard:update");
    io.emit("ranks:update");
    io.emit("quests:update");
}

/* =========================================================
   AUTH
========================================================= */

async function auth(req, res, next) {
    try {
        const header =
            req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return sendError(
                res,
                401,
                "Требуется вход."
            );
        }

        const token = header.slice(7);

        const payload =
            jwt.verify(token, JWT_SECRET);

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE id=$1
            LIMIT 1
            `,
            [payload.id]
        );

        if (!result.rows[0]) {
            throw new Error("USER_NOT_FOUND");
        }

        req.user = result.rows[0];

        next();

    } catch (error) {
        return sendError(
            res,
            401,
            "Сессия недействительна."
        );
    }
}

async function adminAuth(req, res, next) {
    await auth(req, res, async () => {
        if (!isAdminUser(req.user)) {
            return sendError(
                res,
                403,
                "Доступ только для администратора."
            );
        }

        next();
    });
}

/* =========================================================
   BASIC
========================================================= */

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            ok: true,
            service: "ASTRO ONLINE",
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
   AUTH ROUTES
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

        if (!/^\S+@\S+\.\S+$/.test(email)) {
            return sendError(
                res,
                400,
                "Введите корректный email."
            );
        }

        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                username
            )
        ) {
            return sendError(
                res,
                400,
                "Никнейм: 3–20 символов."
            );
        }

        if (password.length < 8) {
            return sendError(
                res,
                400,
                "Пароль должен содержать минимум 8 символов."
            );
        }

        const exists = await pool.query(
            `
            SELECT id
            FROM users
            WHERE lower(email)=lower($1)
               OR lower(username)=lower($2)
            LIMIT 1
            `,
            [email, username]
        );

        if (exists.rows.length) {
            return sendError(
                res,
                409,
                "Email или никнейм уже занят."
            );
        }

        const hash =
            await bcrypt.hash(password, 12);

        const result = await pool.query(
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
                hash
            ]
        );

        const user = result.rows[0];

        broadcastAll();

        res.json({
            token: tokenFor(user),
            user: publicUser(user)
        });

    } catch (error) {
        console.error("REGISTER ERROR:", error);

        return sendError(
            res,
            500,
            "Не удалось создать аккаунт."
        );
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

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE lower(email)=lower($1)
            LIMIT 1
            `,
            [email]
        );

        const user = result.rows[0];

        if (
            !user ||
            !(await bcrypt.compare(
                password,
                user.password_hash
            ))
        ) {
            return sendError(
                res,
                401,
                "Неверный email или пароль."
            );
        }

        const updated =
            await pool.query(
                `
                UPDATE users
                SET last_login_at=now()
                WHERE id=$1
                RETURNING *
                `,
                [user.id]
            );

        const fresh = updated.rows[0];

        res.json({
            token: tokenFor(fresh),
            user: publicUser(fresh),
            isAdmin: isAdminUser(fresh)
        });

    } catch (error) {
        console.error("LOGIN ERROR:", error);

        return sendError(
            res,
            500,
            "Ошибка входа."
        );
    }
});

app.get("/api/me", auth, async (req, res) => {
    res.json({
        user: publicUser(req.user),
        isAdmin: isAdminUser(req.user)
    });
});

/* =========================================================
   PROFILE
========================================================= */

app.put("/api/profile", auth, async (req, res) => {
    try {
        const username =
            String(req.body?.username || "").trim();

        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                username
            )
        ) {
            return sendError(
                res,
                400,
                "Никнейм: 3–20 символов."
            );
        }

        const duplicate =
            await pool.query(
                `
                SELECT id
                FROM users
                WHERE lower(username)=lower($1)
                  AND id<>$2
                LIMIT 1
                `,
                [
                    username,
                    req.user.id
                ]
            );

        if (duplicate.rows.length) {
            return sendError(
                res,
                409,
                "Такой никнейм уже занят."
            );
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

        broadcastAll();

        res.json({
            user: publicUser(result.rows[0])
        });

    } catch (error) {
        console.error("PROFILE ERROR:", error);

        return sendError(
            res,
            500,
            "Не удалось сохранить профиль."
        );
    }
});

/* =========================================================
   RANKS
========================================================= */

app.get("/api/ranks", async (req, res) => {
    try {
        const result =
            await pool.query(`
                SELECT
                    id,
                    rank_id,
                    name,
                    title,
                    price,
                    color,
                    icon,
                    created_at
                FROM ranks
                ORDER BY price ASC, created_at ASC
            `);

        res.json({
            ranks: result.rows.map(rank => ({
                id: rank.id,
                rankId: rank.rank_id,
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

        return sendError(
            res,
            500,
            "Ошибка загрузки рангов."
        );
    }
});

app.post(
    "/api/ranks/:rankId/buy",
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
                    [req.params.rankId]
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
                Array.isArray(user.owned_ranks)
                    ? [...user.owned_ranks]
                    : [];

            if (owned.includes(rank.rank_id)) {
                throw new Error(
                    "Этот ранг уже куплен."
                );
            }

            const balance =
                Number(user.balance || 0);

            const price =
                Number(rank.price || 0);

            if (balance < price) {
                throw new Error(
                    `Не хватает ${(price - balance).toLocaleString("ru-RU")} ₽`
                );
            }

            owned.push(rank.rank_id);

            const history = [
                ...(Array.isArray(user.history)
                    ? user.history
                    : []),
                {
                    title:
                        `Покупка ранга · ${rank.name}`,
                    amount: -price,
                    createdAt:
                        new Date().toISOString()
                }
            ].slice(-50);

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance=balance-$1,
                        owned_ranks=$2::jsonb,
                        history=$3::jsonb
                    WHERE id=$4
                    RETURNING *
                    `,
                    [
                        price,
                        JSON.stringify(owned),
                        JSON.stringify(history),
                        user.id
                    ]
                );

            await client.query("COMMIT");

            broadcastAll();

            res.json({
                user:
                    publicUser(updated.rows[0]),
                rank: {
                    id: rank.id,
                    rankId: rank.rank_id,
                    name: rank.name,
                    title: rank.title,
                    price: price,
                    color: rank.color,
                    icon: rank.icon
                }
            });

        } catch (error) {
            await client.query("ROLLBACK");

            return sendError(
                res,
                400,
                error.message || "Не удалось купить ранг."
            );
        } finally {
            client.release();
        }
    }
);

/* =========================================================
   PLAYER CURRENT RANK
========================================================= */

app.get(
    "/api/users/:id/rank",
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        u.id,
                        u.elo,
                        u.owned_ranks
                    FROM users u
                    WHERE u.id=$1
                    LIMIT 1
                    `,
                    [req.params.id]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Игрок не найден."
                );
            }

            const user =
                result.rows[0];

            const owned =
                Array.isArray(user.owned_ranks)
                    ? user.owned_ranks
                    : [];

            let currentRank = null;

            if (owned.length) {
                const ranks =
                    await pool.query(
                        `
                        SELECT *
                        FROM ranks
                        WHERE rank_id = ANY($1::text[])
                        `,
                        [owned]
                    );

                const rankMap =
                    new Map(
                        ranks.rows.map(
                            r => [r.rank_id, r]
                        )
                    );

                /*
                   Последний купленный ранг
                   считается текущим.
                */

                for (
                    let i = owned.length - 1;
                    i >= 0;
                    i--
                ) {
                    const rank =
                        rankMap.get(owned[i]);

                    if (rank) {
                        currentRank = {
                            id: rank.id,
                            rankId: rank.rank_id,
                            name: rank.name,
                            title: rank.title,
                            price: Number(rank.price),
                            color: rank.color,
                            icon: rank.icon
                        };

                        break;
                    }
                }
            }

            res.json({
                rank: currentRank
            });

        } catch (error) {
            console.error(
                "CURRENT RANK ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Ошибка загрузки ранга."
            );
        }
    }
);

/* =========================================================
   QUESTS
========================================================= */

app.get("/api/quests", async (req, res) => {
    try {
        const result =
            await pool.query(`
                SELECT
                    id,
                    quest_id,
                    title,
                    description,
                    reward,
                    xp,
                    created_at
                FROM quests
                ORDER BY created_at ASC
            `);

        res.json({
            quests: result.rows.map(q => ({
                id: q.id,
                questId: q.quest_id,
                title: q.title,
                description: q.description,
                reward: Number(q.reward),
                xp: Number(q.xp),
                createdAt: q.created_at
            }))
        });

    } catch (error) {
        console.error(
            "QUESTS ERROR:",
            error
        );

        return sendError(
            res,
            500,
            "Ошибка загрузки квестов."
        );
    }
});

app.post(
    "/api/quests/:questId/claim",
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
                    [req.params.questId]
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
                typeof user.claimed_quests === "object"
                    ? { ...user.claimed_quests }
                    : {};

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
                ...(Array.isArray(user.history)
                    ? user.history
                    : []),
                {
                    title:
                        `Квест · ${quest.title}`,
                    amount: reward,
                    createdAt:
                        new Date().toISOString()
                }
            ].slice(-50);

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance=balance+$1,
                        xp=xp+$2,
                        claimed_quests=$3::jsonb,
                        history=$4::jsonb
                    WHERE id=$5
                    RETURNING *
                    `,
                    [
                        reward,
                        xp,
                        JSON.stringify(claimed),
                        JSON.stringify(history),
                        user.id
                    ]
                );

            await client.query("COMMIT");

            broadcastAll();

            res.json({
                user:
                    publicUser(updated.rows[0]),
                reward,
                xp
            });

        } catch (error) {
            await client.query("ROLLBACK");

            return sendError(
                res,
                400,
                error.message ||
                "Не удалось получить квест."
            );
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
                await pool.query(`
                    SELECT
                        id,
                        username,
                        email,
                        elo,
                        xp,
                        wins,
                        balance,
                        owned_ranks
                    FROM users
                    ORDER BY
                        elo DESC,
                        wins DESC,
                        xp DESC,
                        created_at ASC
                `);

            const players =
                result.rows.map(
                    (u, index) => ({
                        id: u.id,
                        position: index + 1,
                        username: u.username,
                        email: u.email,

                        elo: Number(u.elo || 0),
                        xp: Number(u.xp || 0),
                        wins: Number(u.wins || 0),
                        balance:
                            Number(u.balance || 0),

                        ownedRanks:
                            u.owned_ranks || []
                    })
                );

            res.json({
                players
            });

        } catch (error) {
            console.error(
                "LEADERBOARD ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Ошибка рейтинга."
            );
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
                await pool.query(
                    `
                    SELECT
                        id,
                        email,
                        username,
                        balance,
                        xp,
                        elo,
                        wins,
                        owned_ranks,
                        created_at
                    FROM users
                    WHERE
                        $1=''
                        OR username ILIKE '%' || $1 || '%'
                        OR email ILIKE '%' || $1 || '%'
                    ORDER BY elo DESC, wins DESC
                    LIMIT 100
                    `,
                    [search]
                );

            res.json({
                users: result.rows.map(u => ({
                    id: u.id,
                    email: u.email,
                    username: u.username,

                    balance:
                        Number(u.balance || 0),

                    xp:
                        Number(u.xp || 0),

                    elo:
                        Number(u.elo || 0),

                    wins:
                        Number(u.wins || 0),

                    ownedRanks:
                        u.owned_ranks || [],

                    createdAt:
                        u.created_at
                }))
            });

        } catch (error) {
            console.error(
                "ADMIN USERS ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Ошибка загрузки игроков."
            );
        }
    }
);

/* =========================================================
   ADMIN UPDATE USER
========================================================= */

app.put(
    "/api/admin/users/:id",
    adminAuth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {
            await client.query("BEGIN");

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id=$1
                    FOR UPDATE
                    `,
                    [req.params.id]
                );

            const user =
                result.rows[0];

            if (!user) {
                throw new Error(
                    "Игрок не найден."
                );
            }

            const has =
                (key) =>
                    Object.prototype.hasOwnProperty
                        .call(req.body || {}, key);

            const elo =
                has("elo")
                    ? Math.max(
                        0,
                        Number(req.body.elo)
                    )
                    : Number(user.elo);

            const wins =
                has("wins")
                    ? Math.max(
                        0,
                        Number(req.body.wins)
                    )
                    : Number(user.wins);

            const balance =
                has("balance")
                    ? Math.max(
                        0,
                        Number(req.body.balance)
                    )
                    : Number(user.balance);

            const xp =
                has("xp")
                    ? Math.max(
                        0,
                        Number(req.body.xp)
                    )
                    : Number(user.xp);

            const updated =
                await client.query(
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
                        elo,
                        wins,
                        balance,
                        xp,
                        user.id
                    ]
                );

            await client.query(
                `
                INSERT INTO admin_logs
                    (
                        admin_email,
                        action,
                        target_user,
                        details
                    )
                VALUES
                    ($1,$2,$3,$4::jsonb)
                `,
                [
                    req.user.email,
                    "UPDATE_USER",
                    user.id,
                    JSON.stringify({
                        elo,
                        wins,
                        balance,
                        xp
                    })
                ]
            );

            await client.query("COMMIT");

            broadcastAll();

            res.json({
                user:
                    publicUser(updated.rows[0])
            });

        } catch (error) {
            await client.query("ROLLBACK");

            return sendError(
                res,
                400,
                error.message ||
                "Не удалось изменить игрока."
            );
        } finally {
            client.release();
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
                Number(req.body?.amount || 0);

            if (!Number.isFinite(amount)) {
                return sendError(
                    res,
                    400,
                    "Некорректное количество ELO."
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET elo=GREATEST(0,elo+$1)
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        amount,
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Игрок не найден."
                );
            }

            await pool.query(
                `
                INSERT INTO admin_logs
                    (
                        admin_email,
                        action,
                        target_user,
                        details
                    )
                VALUES
                    ($1,$2,$3,$4::jsonb)
                `,
                [
                    req.user.email,
                    "GIVE_ELO",
                    req.params.id,
                    JSON.stringify({
                        amount
                    })
                ]
            );

            broadcastAll();

            res.json({
                user:
                    publicUser(result.rows[0])
            });

        } catch (error) {
            console.error(
                "GIVE ELO ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось изменить ELO."
            );
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
                Number(req.body?.amount || 0);

            if (!Number.isFinite(amount)) {
                return sendError(
                    res,
                    400,
                    "Некорректное количество побед."
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET wins=GREATEST(0,wins+$1)
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        amount,
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Игрок не найден."
                );
            }

            await pool.query(
                `
                INSERT INTO admin_logs
                    (
                        admin_email,
                        action,
                        target_user,
                        details
                    )
                VALUES
                    ($1,$2,$3,$4::jsonb)
                `,
                [
                    req.user.email,
                    "GIVE_WINS",
                    req.params.id,
                    JSON.stringify({
                        amount
                    })
                ]
            );

            broadcastAll();

            res.json({
                user:
                    publicUser(result.rows[0])
            });

        } catch (error) {
            console.error(
                "GIVE WINS ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось изменить победы."
            );
        }
    }
);

/* =========================================================
   ADMIN GIVE BALANCE
========================================================= */

app.post(
    "/api/admin/users/:id/balance",
    adminAuth,
    async (req, res) => {

        try {
            const amount =
                Number(req.body?.amount || 0);

            if (!Number.isFinite(amount)) {
                return sendError(
                    res,
                    400,
                    "Некорректная сумма."
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET balance=GREATEST(0,balance+$1)
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        amount,
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Игрок не найден."
                );
            }

            await pool.query(
                `
                INSERT INTO admin_logs
                    (
                        admin_email,
                        action,
                        target_user,
                        details
                    )
                VALUES
                    ($1,$2,$3,$4::jsonb)
                `,
                [
                    req.user.email,
                    "GIVE_BALANCE",
                    req.params.id,
                    JSON.stringify({
                        amount
                    })
                ]
            );

            broadcastAll();

            res.json({
                user:
                    publicUser(result.rows[0])
            });

        } catch (error) {
            console.error(
                "GIVE BALANCE ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось изменить баланс."
            );
        }
    }
);

/* =========================================================
   ADMIN GIVE XP
========================================================= */

app.post(
    "/api/admin/users/:id/xp",
    adminAuth,
    async (req, res) => {

        try {
            const amount =
                Number(req.body?.amount || 0);

            if (!Number.isFinite(amount)) {
                return sendError(
                    res,
                    400,
                    "Некорректное количество XP."
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET xp=GREATEST(0,xp+$1)
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        amount,
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Игрок не найден."
                );
            }

            broadcastAll();

            res.json({
                user:
                    publicUser(result.rows[0])
            });

        } catch (error) {
            console.error(
                "GIVE XP ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось изменить XP."
            );
        }
    }
);

/* =========================================================
   ADMIN GIVE / REMOVE RANK
========================================================= */

app.post(
    "/api/admin/users/:id/ranks/:rankId",
    adminAuth,
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
                    [req.params.rankId]
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
                    [req.params.id]
                );

            const user =
                userResult.rows[0];

            if (!user) {
                throw new Error(
                    "Игрок не найден."
                );
            }

            const owned =
                Array.isArray(user.owned_ranks)
                    ? [...user.owned_ranks]
                    : [];

            if (!owned.includes(rank.rank_id)) {
                owned.push(rank.rank_id);
            }

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET owned_ranks=$1::jsonb
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(owned),
                        user.id
                    ]
                );

            await client.query(
                `
                INSERT INTO admin_logs
                    (
                        admin_email,
                        action,
                        target_user,
                        details
                    )
                VALUES
                    ($1,$2,$3,$4::jsonb)
                `,
                [
                    req.user.email,
                    "GIVE_RANK",
                    user.id,
                    JSON.stringify({
                        rankId: rank.rank_id
                    })
                ]
            );

            await client.query("COMMIT");

            broadcastAll();

            res.json({
                user:
                    publicUser(updated.rows[0])
            });

        } catch (error) {
            await client.query("ROLLBACK");

            return sendError(
                res,
                400,
                error.message
            );
        } finally {
            client.release();
        }
    }
);

app.delete(
    "/api/admin/users/:id/ranks/:rankId",
    adminAuth,
    async (req, res) => {

        try {
            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id=$1
                    LIMIT 1
                    `,
                    [req.params.id]
                );

            const user =
                result.rows[0];

            if (!user) {
                return sendError(
                    res,
                    404,
                    "Игрок не найден."
                );
            }

            const owned =
                Array.isArray(user.owned_ranks)
                    ? user.owned_ranks.filter(
                        id =>
                            id !== req.params.rankId
                    )
                    : [];

            const updated =
                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks=$1::jsonb
                    WHERE id=$2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(owned),
                        user.id
                    ]
                );

            broadcastAll();

            res.json({
                user:
                    publicUser(updated.rows[0])
            });

        } catch (error) {
            console.error(
                "REMOVE RANK ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось снять ранг."
            );
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

        const result =
            await pool.query(`
                SELECT *
                FROM ranks
                ORDER BY price ASC, created_at ASC
            `);

        res.json({
            ranks: result.rows.map(r => ({
                id: r.id,
                rankId: r.rank_id,
                name: r.name,
                title: r.title,
                price: Number(r.price),
                color: r.color,
                icon: r.icon,
                createdAt: r.created_at
            }))
        });
    }
);

app.post(
    "/api/admin/ranks",
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
                Number(req.body?.price || 0);

            const color =
                String(
                    req.body?.color || "#8b5cf6"
                ).trim();

            const icon =
                String(
                    req.body?.icon || "★"
                ).trim();

            if (
                !/^[a-zA-Z0-9_-]{2,40}$/.test(
                    rankId
                )
            ) {
                return sendError(
                    res,
                    400,
                    "ID ранга: 2–40 символов."
                );
            }

            if (!name || !title) {
                return sendError(
                    res,
                    400,
                    "Название и титул обязательны."
                );
            }

            if (
                !Number.isFinite(price) ||
                price < 0
            ) {
                return sendError(
                    res,
                    400,
                    "Некорректная цена."
                );
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
                        price,
                        color,
                        icon
                    ]
                );

            broadcastAll();

            res.json({
                rank: {
                    id: result.rows[0].id,
                    rankId: result.rows[0].rank_id,
                    name: result.rows[0].name,
                    title: result.rows[0].title,
                    price:
                        Number(result.rows[0].price),
                    color: result.rows[0].color,
                    icon: result.rows[0].icon
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
                return sendError(
                    res,
                    409,
                    "Такой ID ранга уже существует."
                );
            }

            return sendError(
                res,
                500,
                "Не удалось создать ранг."
            );
        }
    }
);

app.delete(
    "/api/admin/ranks/:rankId",
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
                    [req.params.rankId]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Ранг не найден."
                );
            }

            /*
               Убираем удалённый ранг
               у всех игроков.
            */

            await pool.query(
                `
                UPDATE users
                SET owned_ranks =
                    (
                        SELECT COALESCE(
                            jsonb_agg(value),
                            '[]'::jsonb
                        )
                        FROM jsonb_array_elements(
                            users.owned_ranks
                        )
                        WHERE value <> $1::jsonb
                    )
                `,
                [JSON.stringify(req.params.rankId)]
            );

            broadcastAll();

            res.json({
                ok: true
            });

        } catch (error) {
            console.error(
                "DELETE RANK ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось удалить ранг."
            );
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

        const result =
            await pool.query(`
                SELECT *
                FROM quests
                ORDER BY created_at ASC
            `);

        res.json({
            quests: result.rows.map(q => ({
                id: q.id,
                questId: q.quest_id,
                title: q.title,
                description: q.description,
                reward: Number(q.reward),
                xp: Number(q.xp),
                createdAt: q.created_at
            }))
        });
    }
);

app.post(
    "/api/admin/quests",
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
                Number(req.body?.reward || 0);

            const xp =
                Number(req.body?.xp || 0);

            if (
                !/^[a-zA-Z0-9_-]{2,40}$/.test(
                    questId
                )
            ) {
                return sendError(
                    res,
                    400,
                    "ID квеста: 2–40 символов."
                );
            }

            if (!title) {
                return sendError(
                    res,
                    400,
                    "Название квеста обязательно."
                );
            }

            if (
                !Number.isFinite(reward) ||
                reward < 0
            ) {
                return sendError(
                    res,
                    400,
                    "Некорректная награда."
                );
            }

            if (
                !Number.isFinite(xp) ||
                xp < 0
            ) {
                return sendError(
                    res,
                    400,
                    "Некорректный XP."
                );
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
                        reward,
                        xp
                    ]
                );

            broadcastAll();

            res.json({
                quest: {
                    id: result.rows[0].id,
                    questId:
                        result.rows[0].quest_id,
                    title:
                        result.rows[0].title,
                    description:
                        result.rows[0].description,
                    reward:
                        Number(result.rows[0].reward),
                    xp:
                        Number(result.rows[0].xp)
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
                return sendError(
                    res,
                    409,
                    "Такой ID квеста уже существует."
                );
            }

            return sendError(
                res,
                500,
                "Не удалось создать квест."
            );
        }
    }
);

app.delete(
    "/api/admin/quests/:questId",
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
                    [req.params.questId]
                );

            if (!result.rows[0]) {
                return sendError(
                    res,
                    404,
                    "Квест не найден."
                );
            }

            broadcastAll();

            res.json({
                ok: true
            });

        } catch (error) {
            console.error(
                "DELETE QUEST ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "Не удалось удалить квест."
            );
        }
    }
);

/* =========================================================
   ADMIN STATS
========================================================= */

app.get(
    "/api/admin/stats",
    adminAuth,
    async (req, res) => {

        try {
            const users =
                await pool.query(
                    `SELECT COUNT(*)::int AS count FROM users`
                );

            const ranks =
                await pool.query(
                    `SELECT COUNT(*)::int AS count FROM ranks`
                );

            const quests =
                await pool.query(
                    `SELECT COUNT(*)::int AS count FROM quests`
                );

            res.json({
                users:
                    users.rows[0].count,
                ranks:
                    ranks.rows[0].count,
                quests:
                    quests.rows[0].count
            });

        } catch (error) {
            return sendError(
                res,
                500,
                "Ошибка статистики."
            );
        }
    }
);

/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", socket => {
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

/* =========================================================
   FRONTEND FALLBACK
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
        error: "Внутренняя ошибка сервера."
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
                console.log(
                    `ASTRO ONLINE listening on :${PORT}`
                );
            }
        );

    } catch (error) {
        console.error(
            "FATAL SERVER ERROR:"
        );

        console.error(error);

        process.exit(1);
    }
}

process.on(
    "unhandledRejection",
    error => {
        console.error(
            "UNHANDLED REJECTION:",
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.error(
            "UNCAUGHT EXCEPTION:",
            error
        );
    }
);

start();
```
