require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET =
    process.env.JWT_SECRET ||
    "astro-secret-change-this";

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL ||
    "admin@astro.online";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    "admin123";

if (!DATABASE_URL) {
    console.error("DATABASE_URL не найден в Environment.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
        DATABASE_URL &&
        /localhost|127\.0\.0\.1/.test(DATABASE_URL)
            ? false
            : {
                rejectUnauthorized: false
            }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));


/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {

    /*
     * USERS
     */

    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY,
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
     * RANKS
     *
     * ВАЖНО:
     * Эта часть специально исправляет твою ошибку:
     *
     * column "rank_id" of relation "ranks" does not exist
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id SERIAL PRIMARY KEY,
            rank_id TEXT UNIQUE,
            name TEXT NOT NULL DEFAULT 'RANK',
            title TEXT NOT NULL DEFAULT 'Ранг',
            price BIGINT NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#ffffff',
            icon TEXT NOT NULL DEFAULT '★',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);


    /*
     * МИГРАЦИЯ СТАРОЙ ТАБЛИЦЫ RANKS
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
        ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#ffffff'
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '★'
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()
    `);


    /*
     * Старым рангам выдаём ID
     */

    await pool.query(`
        UPDATE ranks
        SET rank_id = 'rank-' || id
        WHERE rank_id IS NULL
           OR rank_id = ''
    `);

    await pool.query(`
        UPDATE ranks
        SET name = 'RANK-' || id
        WHERE name IS NULL
           OR name = ''
    `);

    await pool.query(`
        UPDATE ranks
        SET title = name
        WHERE title IS NULL
           OR title = ''
    `);

    await pool.query(`
        UPDATE ranks
        SET price = 0
        WHERE price IS NULL
    `);

    await pool.query(`
        UPDATE ranks
        SET color = '#ffffff'
        WHERE color IS NULL
           OR color = ''
    `);

    await pool.query(`
        UPDATE ranks
        SET icon = '★'
        WHERE icon IS NULL
           OR icon = ''
    `);

    await pool.query(`
        UPDATE ranks
        SET created_at = now()
        WHERE created_at IS NULL
    `);


    /*
     * Уникальный индекс
     */

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        ranks_rank_id_unique
        ON ranks(rank_id)
    `);


    /*
     * QUESTS
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quests (
            id SERIAL PRIMARY KEY,
            quest_id TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            reward BIGINT NOT NULL DEFAULT 0,
            xp BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);


    /*
     * Если квестов нет — создаём стандартные
     */

    const questsCount = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM quests
    `);

    if (questsCount.rows[0].count === 0) {

        await pool.query(`
            INSERT INTO quests
                (quest_id, title, description, reward, xp)
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
                    'Посети разделы ASTRO и изучи новый сезон.',
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
        `);
    }


    /*
     * Если рангов нет — создаём стандартные
     */

    const ranksCount = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM ranks
    `);

    if (ranksCount.rows[0].count === 0) {

        await pool.query(`
            INSERT INTO
                ranks
                (rank_id, name, title, price, color, icon)
            VALUES
                (
                    'bronze',
                    'BRONZE',
                    'Бронзовый',
                    5000,
                    '#cd7f32',
                    '◆'
                ),
                (
                    'silver',
                    'SILVER',
                    'Серебряный',
                    15000,
                    '#b9c3d0',
                    '◇'
                ),
                (
                    'gold',
                    'GOLD',
                    'Золотой',
                    35000,
                    '#ffd45a',
                    '✦'
                ),
                (
                    'diamond',
                    'DIAMOND',
                    'Алмазный',
                    75000,
                    '#6ee7ff',
                    '✧'
                ),
                (
                    'master',
                    'MASTER',
                    'Мастер',
                    150000,
                    '#c084fc',
                    '✹'
                ),
                (
                    'astro',
                    'ASTRO',
                    'ASTRO ELITE',
                    300000,
                    '#ff6bd6',
                    '★'
                )
        `);
    }


    /*
     * ADMIN
     *
     * Админ создаётся автоматически.
     */

    const adminExists = await pool.query(`
        SELECT id
        FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1
    `, [ADMIN_EMAIL]);

    if (!adminExists.rows.length) {

        const passwordHash =
            await bcrypt.hash(ADMIN_PASSWORD, 12);

        await pool.query(`
            INSERT INTO users (
                id,
                email,
                username,
                password_hash,
                balance,
                xp,
                elo,
                wins
            )
            VALUES (
                gen_random_uuid(),
                $1,
                'ADMIN',
                $2,
                999999999,
                999999999,
                999999,
                999999
            )
        `, [
            ADMIN_EMAIL,
            passwordHash
        ]);

        console.log("=================================");
        console.log("ASTRO ADMIN CREATED");
        console.log("Email:", ADMIN_EMAIL);
        console.log("Password:", ADMIN_PASSWORD);
        console.log("=================================");
    }

    console.log("ASTRO DATABASE READY");
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

        ownedRanks:
            Array.isArray(user.owned_ranks)
                ? user.owned_ranks
                : [],

        claimedQuests:
            user.claimed_quests || {},

        history:
            Array.isArray(user.history)
                ? user.history
                : [],

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


function broadcast() {

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

            return res.status(401).json({
                error: "Требуется вход."
            });
        }

        const token =
            header.slice(7);

        const payload =
            jwt.verify(
                token,
                JWT_SECRET
            );

        const result =
            await pool.query(
                `
                SELECT *
                FROM users
                WHERE id = $1
                `,
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

        if (
            String(req.user.email).toLowerCase() !==
            String(ADMIN_EMAIL).toLowerCase()
        ) {

            return res.status(403).json({
                error: "Доступ только для администратора."
            });
        }

        next();
    });
}


/* =========================================================
   AUTH API
========================================================= */

app.get("/api/me", auth, (req, res) => {

    res.json({
        user: publicUser(req.user)
    });
});


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


        if (
            !/^\S+@\S+\.\S+$/.test(e)
        ) {

            return res.status(400).json({
                error: "Введите корректный email."
            });
        }


        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(n)
        ) {

            return res.status(400).json({
                error: "Никнейм: 3–20 символов."
            });
        }


        if (p.length < 8) {

            return res.status(400).json({
                error:
                    "Пароль должен содержать минимум 8 символов."
            });
        }


        const exists =
            await pool.query(
                `
                SELECT 1
                FROM users
                WHERE lower(email) = lower($1)
                   OR lower(username) = lower($2)
                `,
                [e, n]
            );


        if (exists.rowCount) {

            return res.status(409).json({
                error:
                    "Email или никнейм уже занят."
            });
        }


        const hash =
            await bcrypt.hash(p, 12);


        const result =
            await pool.query(
                `
                INSERT INTO users (
                    id,
                    email,
                    username,
                    password_hash
                )
                VALUES (
                    gen_random_uuid(),
                    $1,
                    $2,
                    $3
                )
                RETURNING *
                `,
                [
                    e,
                    n,
                    hash
                ]
            );


        const user =
            result.rows[0];

        broadcast();

        res.json({
            token: tokenFor(user),
            user: publicUser(user)
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                "Не удалось создать аккаунт."
        });
    }
});


app.post("/api/login", async (req, res) => {

    try {

        const {
            email,
            password
        } = req.body || {};

        const e =
            String(email || "")
                .trim()
                .toLowerCase();

        const p =
            String(password || "");


        const result =
            await pool.query(
                `
                SELECT *
                FROM users
                WHERE lower(email) = lower($1)
                LIMIT 1
                `,
                [e]
            );


        const user =
            result.rows[0];


        if (
            !user ||
            !(await bcrypt.compare(
                p,
                user.password_hash
            ))
        ) {

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
            (
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    `,
                    [user.id]
                )
            ).rows[0];


        res.json({
            token: tokenFor(fresh),
            user: publicUser(fresh)
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Ошибка входа."
        });
    }
});


/* =========================================================
   PROFILE
========================================================= */

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
                        "Никнейм: 3–20 символов."
                });
            }


            const duplicate =
                await pool.query(
                    `
                    SELECT 1
                    FROM users
                    WHERE lower(username) =
                          lower($1)
                      AND id <> $2
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
                    SET username = $1
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        username,
                        req.user.id
                    ]
                );


            broadcast();

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
                    "Не удалось сохранить профиль."
            });
        }
    }
);


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
                ORDER BY price ASC, id ASC
            `);


        res.json({
            ranks:
                result.rows.map(rank => ({
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

        res.status(500).json({
            error:
                "Ошибка загрузки рангов."
        });
    }
});


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
                    WHERE rank_id = $1
                    FOR SHARE
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
                    WHERE id = $1
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


            if (
                owned.includes(
                    rank.rank_id
                )
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
                [
                    ...(Array.isArray(user.history)
                        ? user.history
                        : []),

                    {
                        title:
                            `Покупка ранга · ${rank.name}`,

                        amount:
                            -price,

                        createdAt:
                            new Date().toISOString()
                    }
                ].slice(-30);


            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance =
                            balance - $1,
                        owned_ranks =
                            $2::jsonb,
                        history =
                            $3::jsonb
                    WHERE id = $4
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

            broadcast();


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
                    price: price,
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
                ORDER BY id ASC
            `);


        res.json({
            quests:
                result.rows.map(q => ({
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

        console.error("QUESTS ERROR:", error);

        res.status(500).json({
            error:
                "Ошибка загрузки квестов."
        });
    }
});


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
                    WHERE quest_id = $1
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
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [req.user.id]
                );


            const user =
                userResult.rows[0];


            const claimed =
                user.claimed_quests || {};


            if (
                claimed[quest.quest_id]
            ) {

                throw new Error(
                    "Этот квест уже получен."
                );
            }


            claimed[quest.quest_id] = true;


            const history =
                [
                    ...(Array.isArray(user.history)
                        ? user.history
                        : []),

                    {
                        title:
                            `Квест · ${quest.title}`,

                        amount:
                            Number(quest.reward),

                        createdAt:
                            new Date().toISOString()
                    }
                ].slice(-30);


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
                            $3::jsonb,
                        history =
                            $4::jsonb
                    WHERE id = $5
                    RETURNING *
                    `,
                    [
                        Number(quest.reward),
                        Number(quest.xp),
                        JSON.stringify(claimed),
                        JSON.stringify(history),
                        user.id
                    ]
                );


            await client.query("COMMIT");

            broadcast();


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

            const users =
                await pool.query(`
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
                        wins DESC
                `);


            const quests =
                await pool.query(`
                    SELECT
                        id,
                        quest_id,
                        title,
                        description,
                        reward,
                        xp
                    FROM quests
                    ORDER BY id ASC
                `);


            res.json({

                players:
                    users.rows.map(u => ({
                        id: u.id,
                        username: u.username,
                        elo: Number(u.elo),
                        xp: Number(u.xp),
                        wins: Number(u.wins),
                        ownedRanks:
                            u.owned_ranks || []
                    })),

                quests:
                    quests.rows.map(q => ({
                        id: q.id,
                        questId: q.quest_id,
                        title: q.title,
                        description: q.description,
                        reward: Number(q.reward),
                        xp: Number(q.xp)
                    }))
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Ошибка рейтинга."
            });
        }
    }
);


/* =========================================================
   ADMIN — USERS
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
                        owned_ranks
                    FROM users

                    WHERE
                        $1 = ''
                        OR username ILIKE '%' || $1 || '%'
                        OR email ILIKE '%' || $1 || '%'

                    ORDER BY
                        elo DESC

                    LIMIT 100
                    `,
                    [search]
                );


            res.json({
                users:
                    result.rows.map(u => ({
                        id: u.id,
                        email: u.email,
                        username: u.username,
                        balance: Number(u.balance),
                        xp: Number(u.xp),
                        elo: Number(u.elo),
                        wins: Number(u.wins),
                        ownedRanks:
                            u.owned_ranks || []
                    }))
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Ошибка загрузки игроков."
            });
        }
    }
);


/* =========================================================
   ADMIN — EDIT USER
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


            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET
                        elo = $1,
                        wins = $2,
                        balance = $3
                    WHERE id = $4
                    RETURNING *
                    `,
                    [
                        elo,
                        wins,
                        balance,
                        req.params.id
                    ]
                );


            if (!result.rows[0]) {

                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }


            broadcast();


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
                    "Не удалось изменить игрока."
            });
        }
    }
);


/* =========================================================
   ADMIN — GIVE RANK
========================================================= */

app.post(
    "/api/admin/users/:id/ranks/:rankId",
    adminAuth,
    async (req, res) => {

        try {

            const userResult =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    `,
                    [req.params.id]
                );


            const user =
                userResult.rows[0];


            if (!user) {

                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }


            const rankResult =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE rank_id = $1
                    `,
                    [req.params.rankId]
                );


            const rank =
                rankResult.rows[0];


            if (!rank) {

                return res.status(404).json({
                    error:
                        "Ранг не найден."
                });
            }


            const owned =
                Array.isArray(user.owned_ranks)
                    ? [...user.owned_ranks]
                    : [];


            if (!owned.includes(rank.rank_id)) {

                owned.push(rank.rank_id);
            }


            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks = $1::jsonb
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(owned),
                        user.id
                    ]
                );


            broadcast();


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
                    "Не удалось выдать ранг."
            });
        }
    }
);


/* =========================================================
   ADMIN — REMOVE RANK
========================================================= */

app.delete(
    "/api/admin/users/:id/ranks/:rankId",
    adminAuth,
    async (req, res) => {

        try {

            const userResult =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    `,
                    [req.params.id]
                );


            const user =
                userResult.rows[0];


            if (!user) {

                return res.status(404).json({
                    error:
                        "Игрок не найден."
                });
            }


            const owned =
                Array.isArray(user.owned_ranks)
                    ? user.owned_ranks.filter(
                        rank =>
                            rank !== req.params.rankId
                    )
                    : [];


            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks = $1::jsonb
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(owned),
                        user.id
                    ]
                );


            broadcast();


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
                    "Не удалось снять ранг."
            });
        }
    }
);


/* =========================================================
   ADMIN — RANKS
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
                    ORDER BY price ASC, id ASC
                `);


            res.json({
                ranks:
                    result.rows.map(r => ({
                        id: r.rank_id,
                        databaseId: r.id,
                        rankId: r.rank_id,
                        name: r.name,
                        title: r.title,
                        price: Number(r.price),
                        color: r.color,
                        icon: r.icon,
                        createdAt: r.created_at
                    }))
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Ошибка загрузки рангов."
            });
        }
    }
);


/* =========================================================
   ADMIN — CREATE RANK
========================================================= */

app.post(
    "/api/admin/ranks",
    adminAuth,
    async (req, res) => {

        try {

            const rankId =
                String(
                    req.body.rankId || ""
                ).trim().toLowerCase();

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
                    Number(
                        req.body.price || 0
                    )
                );

            const color =
                String(
                    req.body.color || "#ffffff"
                ).trim();

            const icon =
                String(
                    req.body.icon || "★"
                ).trim();


            if (!rankId) {

                return res.status(400).json({
                    error:
                        "Укажи ID ранга."
                });
            }


            if (!name) {

                return res.status(400).json({
                    error:
                        "Укажи название ранга."
                });
            }


            if (!title) {

                return res.status(400).json({
                    error:
                        "Укажи титул ранга."
                });
            }


            const exists =
                await pool.query(
                    `
                    SELECT 1
                    FROM ranks
                    WHERE rank_id = $1
                    `,
                    [rankId]
                );


            if (exists.rowCount) {

                return res.status(409).json({
                    error:
                        "Такой ID ранга уже существует."
                });
            }


            const result =
                await pool.query(
                    `
                    INSERT INTO ranks (
                        rank_id,
                        name,
                        title,
                        price,
                        color,
                        icon
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
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


            broadcast();


            res.json({
                rank: {
                    id:
                        result.rows[0].rank_id,

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

            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось создать ранг."
            });
        }
    }
);


/* =========================================================
   ADMIN — DELETE RANK
========================================================= */

app.delete(
    "/api/admin/ranks/:id",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM ranks
                    WHERE rank_id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );


            if (!result.rows[0]) {

                return res.status(404).json({
                    error:
                        "Ранг не найден."
                });
            }


            /*
             * Удаляем этот ранг
             * у всех игроков.
             */

            const users =
                await pool.query(`
                    SELECT id, owned_ranks
                    FROM users
                `);


            for (const user of users.rows) {

                const owned =
                    Array.isArray(user.owned_ranks)
                        ? user.owned_ranks.filter(
                            r =>
                                r !== req.params.id
                        )
                        : [];


                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks = $1::jsonb
                    WHERE id = $2
                    `,
                    [
                        JSON.stringify(owned),
                        user.id
                    ]
                );
            }


            broadcast();


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
   ADMIN — QUESTS
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
                    ORDER BY id ASC
                `);


            res.json({
                quests:
                    result.rows.map(q => ({
                        id: q.quest_id,
                        databaseId: q.id,
                        questId: q.quest_id,
                        title: q.title,
                        description: q.description,
                        reward: Number(q.reward),
                        xp: Number(q.xp),
                        createdAt: q.created_at
                    }))
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Ошибка загрузки квестов."
            });
        }
    }
);


/* =========================================================
   ADMIN — CREATE QUEST
========================================================= */

app.post(
    "/api/admin/quests",
    adminAuth,
    async (req, res) => {

        try {

            const questId =
                String(
                    req.body.questId || ""
                ).trim().toLowerCase();

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
                    Number(
                        req.body.reward || 0
                    )
                );

            const xp =
                Math.max(
                    0,
                    Number(
                        req.body.xp || 0
                    )
                );


            if (!questId) {

                return res.status(400).json({
                    error:
                        "Укажи ID квеста."
                });
            }


            if (!title) {

                return res.status(400).json({
                    error:
                        "Укажи название квеста."
                });
            }


            const exists =
                await pool.query(
                    `
                    SELECT 1
                    FROM quests
                    WHERE quest_id = $1
                    `,
                    [questId]
                );


            if (exists.rowCount) {

                return res.status(409).json({
                    error:
                        "Такой ID квеста уже существует."
                });
            }


            const result =
                await pool.query(
                    `
                    INSERT INTO quests (
                        quest_id,
                        title,
                        description,
                        reward,
                        xp
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5
                    )
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


            broadcast();


            res.json({
                quest: {
                    id:
                        result.rows[0].quest_id,

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

            console.error(error);

            res.status(500).json({
                error:
                    "Не удалось создать квест."
            });
        }
    }
);


/* =========================================================
   ADMIN — DELETE QUEST
========================================================= */

app.delete(
    "/api/admin/quests/:id",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM quests
                    WHERE quest_id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );


            if (!result.rows[0]) {

                return res.status(404).json({
                    error:
                        "Квест не найден."
                });
            }


            /*
             * Удаляем отметку этого квеста
             * у игроков.
             */

            const users =
                await pool.query(`
                    SELECT id, claimed_quests
                    FROM users
                `);


            for (const user of users.rows) {

                const claimed =
                    user.claimed_quests || {};


                delete claimed[
                    req.params.id
                ];


                await pool.query(
                    `
                    UPDATE users
                    SET claimed_quests = $1::jsonb
                    WHERE id = $2
                    `,
                    [
                        JSON.stringify(claimed),
                        user.id
                    ]
                );
            }


            broadcast();


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
   HEALTH CHECK
========================================================= */

app.get(
    "/api/health",
    async (req, res) => {

        try {

            await pool.query(
                "SELECT 1"
            );

            res.json({
                status: "ok",
                database: "connected",
                astro: "online"
            });

        } catch (error) {

            res.status(500).json({
                status: "error",
                database: "offline"
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

                console.log(
                    `Admin email: ${ADMIN_EMAIL}`
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


/* =========================================================
   SOCKET
========================================================= */

io.on("connection", socket => {

    console.log(
        "ASTRO socket connected:",
        socket.id
    );

    socket.on(
        "disconnect",
        () => {
            console.log(
                "ASTRO socket disconnected:",
                socket.id
            );
        }
    );
});
