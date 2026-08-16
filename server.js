```js
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET =
    process.env.JWT_SECRET || "astro-online-secret-change-me";

if (!DATABASE_URL) {
    console.error("FATAL: DATABASE_URL не задан.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function clean(value, max = 200) {
    return String(value ?? "").trim().slice(0, max);
}

function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function id() {
    return (
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10)
    );
}

function signToken(user) {
    return jwt.sign(
        {
            id: String(user.id),
            email: user.email,
            is_admin: Boolean(user.is_admin)
        },
        JWT_SECRET,
        { expiresIn: "30d" }
    );
}

function auth(req, res, next) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Требуется авторизация"
        });
    }

    try {
        req.user = jwt.verify(
            header.slice(7),
            JWT_SECRET
        );

        next();
    } catch {
        return res.status(401).json({
            error: "Недействительная сессия"
        });
    }
}

async function getUser(userId) {
    const result = await pool.query(
        `
        SELECT
            id,
            username,
            email,
            password,
            balance,
            elo,
            xp,
            wins,
            is_admin,
            created_at
        FROM users
        WHERE id::text = $1
        LIMIT 1
        `,
        [String(userId)]
    );

    return result.rows[0] || null;
}

function publicUser(user) {
    if (!user) return null;

    return {
        id: String(user.id),
        username: user.username,
        email: user.email,
        balance: Number(user.balance || 0),
        elo: Number(user.elo || 0),
        xp: Number(user.xp || 0),
        wins: Number(user.wins || 0),
        is_admin: Boolean(user.is_admin)
    };
}

async function admin(req, res, next) {
    try {
        const user = await getUser(req.user.id);

        if (!user || !user.is_admin) {
            return res.status(403).json({
                error: "Нет доступа к админке"
            });
        }

        req.adminUser = user;
        next();
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Ошибка проверки администратора"
        });
    }
}

/*
==================================================
DATABASE
==================================================
*/

async function initDatabase() {
    console.log("ASTRO: подключение к PostgreSQL...");

    await pool.query("SELECT 1");

    console.log("ASTRO: PostgreSQL подключен.");

    /*
     * USERS
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            balance BIGINT NOT NULL DEFAULT 0,
            elo INTEGER NOT NULL DEFAULT 1000,
            xp BIGINT NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            is_admin BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    /*
     * Если users уже существовала со старой версией,
     * добавляем недостающие поля.
     */

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS elo INTEGER NOT NULL DEFAULT 1000
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    /*
     * RANKS
     *
     * ВАЖНО:
     * id здесь TEXT.
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            price BIGINT NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#9b7cff',
            icon TEXT NOT NULL DEFAULT '★',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS name TEXT
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS price BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#9b7cff'
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '★'
    `);

    await pool.query(`
        ALTER TABLE ranks
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    /*
     * USER RANKS
     *
     * Никакого FK на ranks.
     * Это специально сделано, чтобы старые типы PostgreSQL
     * больше не ломали запуск сервера.
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_ranks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            rank_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, rank_id)
        )
    `);

    /*
     * QUESTS
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quests (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            reward BIGINT NOT NULL DEFAULT 0,
            xp BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS title TEXT
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS reward BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE quests
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    /*
     * CLAIMED QUESTS
     */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS claimed_quests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            quest_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, quest_id)
        )
    `);

    /*
     * Удаляем старый конфликтующий FK,
     * если он существует.
     */

    await pool.query(`
        DO $$
        DECLARE
            constraint_name TEXT;
        BEGIN
            SELECT tc.constraint_name
            INTO constraint_name
            FROM information_schema.table_constraints tc
            WHERE tc.table_name = 'user_ranks'
              AND tc.constraint_type = 'FOREIGN KEY'
            LIMIT 1;

            IF constraint_name IS NOT NULL THEN
                EXECUTE
                    'ALTER TABLE user_ranks DROP CONSTRAINT "' ||
                    constraint_name ||
                    '"';
            END IF;
        END $$;
    `);

    /*
     * Если старый rank_id был BIGINT,
     * переводим его в TEXT.
     */

    await pool.query(`
        DO $$
        DECLARE
            data_type TEXT;
        BEGIN
            SELECT c.data_type
            INTO data_type
            FROM information_schema.columns c
            WHERE c.table_name = 'user_ranks'
              AND c.column_name = 'rank_id';

            IF data_type IS NOT NULL
               AND data_type <> 'text' THEN

                ALTER TABLE user_ranks
                ALTER COLUMN rank_id TYPE TEXT
                USING rank_id::TEXT;

            END IF;
        END $$;
    `);

    /*
     * Создаём базовые ранги, только если их ещё нет.
     */

    await pool.query(`
        INSERT INTO ranks
            (id, name, title, price, color, icon)
        VALUES
            ('bronze', 'BRONZE', 'Бронзовый', 5000, '#cd7f32', '◆'),
            ('silver', 'SILVER', 'Серебряный', 15000, '#b9c3d0', '◇'),
            ('gold', 'GOLD', 'Золотой', 35000, '#ffd45a', '✦'),
            ('diamond', 'DIAMOND', 'Алмазный', 75000, '#6ee7ff', '◆'),
            ('master', 'MASTER', 'Мастер', 150000, '#c084fc', '✦'),
            ('astro', 'ASTRO', 'ASTRO ELITE', 300000, '#ff66d9', '★')
        ON CONFLICT (id) DO NOTHING
    `);

    /*
     * Базовые квесты.
     */

    await pool.query(`
        INSERT INTO quests
            (id, title, description, reward, xp)
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
        ON CONFLICT (id) DO NOTHING
    `);

    /*
     * ADMIN
     *
     * Создаём стандартный аккаунт,
     * если его ещё нет.
     */

    const adminEmail = "admin@astro.online";
    const adminPassword = "admin123";

    const existingAdmin = await pool.query(
        `
        SELECT id
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        `,
        [adminEmail]
    );

    if (existingAdmin.rowCount === 0) {
        const hash = await bcrypt.hash(
            adminPassword,
            12
        );

        await pool.query(
            `
            INSERT INTO users
                (
                    id,
                    username,
                    email,
                    password,
                    balance,
                    elo,
                    xp,
                    wins,
                    is_admin
                )
            VALUES
                ($1,$2,$3,$4,0,1000,0,0,TRUE)
            `,
            [
                id(),
                "ASTRO_ADMIN",
                adminEmail,
                hash
            ]
        );

        console.log("");
        console.log("================================");
        console.log("ASTRO ADMIN CREATED");
        console.log("Email: admin@astro.online");
        console.log("Password: admin123");
        console.log("================================");
        console.log("");
    } else {
        await pool.query(
            `
            UPDATE users
            SET is_admin = TRUE
            WHERE LOWER(email) = LOWER($1)
            `,
            [adminEmail]
        );
    }

    console.log("ASTRO: база данных готова.");
}

/*
==================================================
AUTH
==================================================
*/

app.post("/api/register", async (req, res) => {
    try {
        const username = clean(req.body.username, 30);
        const email = clean(req.body.email, 120).toLowerCase();
        const password = String(req.body.password || "");

        if (username.length < 3) {
            return res.status(400).json({
                error: "Никнейм должен быть минимум 3 символа"
            });
        }

        if (!email.includes("@")) {
            return res.status(400).json({
                error: "Введите правильный email"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Пароль должен быть минимум 6 символов"
            });
        }

        const exists = await pool.query(
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = LOWER($1)
               OR LOWER(username) = LOWER($2)
            LIMIT 1
            `,
            [email, username]
        );

        if (exists.rowCount) {
            return res.status(400).json({
                error: "Такой пользователь уже существует"
            });
        }

        const hash = await bcrypt.hash(
            password,
            12
        );

        const result = await pool.query(
            `
            INSERT INTO users
                (
                    id,
                    username,
                    email,
                    password
                )
            VALUES
                ($1,$2,$3,$4)
            RETURNING *
            `,
            [
                id(),
                username,
                email,
                hash
            ]
        );

        const user = result.rows[0];

        res.json({
            token: signToken(user),
            user: publicUser(user)
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Ошибка регистрации"
        });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const email = clean(
            req.body.email,
            120
        ).toLowerCase();

        const password = String(
            req.body.password || ""
        );

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
            `,
            [email]
        );

        if (!result.rowCount) {
            return res.status(401).json({
                error: "Неверный email или пароль"
            });
        }

        const user = result.rows[0];

        const valid = await bcrypt.compare(
            password,
            user.password
        );

        if (!valid) {
            return res.status(401).json({
                error: "Неверный email или пароль"
            });
        }

        res.json({
            token: signToken(user),
            user: publicUser(user)
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Ошибка входа"
        });
    }
});

/*
==================================================
PROFILE
==================================================
*/

app.get("/api/me", auth, async (req, res) => {
    try {
        const user = await getUser(req.user.id);

        if (!user) {
            return res.status(404).json({
                error: "Пользователь не найден"
            });
        }

        const ranks = await pool.query(
            `
            SELECT
                ur.rank_id,
                r.name,
                r.title,
                r.price,
                r.color,
                r.icon
            FROM user_ranks ur
            LEFT JOIN ranks r
                ON r.id::TEXT = ur.rank_id::TEXT
            WHERE ur.user_id::TEXT = $1
            ORDER BY ur.created_at DESC
            `,
            [String(user.id)]
        );

        const result = publicUser(user);

        result.ownedRanks =
            ranks.rows.map(r => ({
                rankId: String(r.rank_id),
                name: r.name,
                title: r.title,
                price: Number(r.price || 0),
                color: r.color,
                icon: r.icon
            }));

        /*
         * Текущий ранг определяется по максимальному
         * купленному рангу.
         */

        const currentRank = ranks.rows
            .filter(r => r.name)
            .sort(
                (a, b) =>
                    Number(b.price || 0) -
                    Number(a.price || 0)
            )[0];

        result.rank = currentRank
            ? {
                id: String(currentRank.rank_id),
                name: currentRank.name,
                title: currentRank.title,
                color: currentRank.color,
                icon: currentRank.icon
            }
            : null;

        res.json({
            user: result
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Ошибка загрузки профиля"
        });
    }
});

/*
==================================================
RANKS
==================================================
*/

app.get("/api/ranks", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                id AS "rankId",
                name,
                title,
                price,
                color,
                icon
            FROM ranks
            ORDER BY price ASC, created_at ASC
        `);

        res.json({
            ranks: result.rows.map(r => ({
                id: String(r.id),
                rankId: String(r.rankId),
                name: r.name,
                title: r.title,
                price: Number(r.price || 0),
                color: r.color,
                icon: r.icon
            }))
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Ошибка загрузки рангов"
        });
    }
});

app.post(
    "/api/ranks/:id/buy",
    auth,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const rankId = String(
                req.params.id
            );

            const userResult = await client.query(
                `
                SELECT *
                FROM users
                WHERE id::TEXT = $1
                FOR UPDATE
                `,
                [String(req.user.id)]
            );

            if (!userResult.rowCount) {
                throw new Error(
                    "Пользователь не найден"
                );
            }

            const rankResult = await client.query(
                `
                SELECT *
                FROM ranks
                WHERE id::TEXT = $1
                LIMIT 1
                `,
                [rankId]
            );

            if (!rankResult.rowCount) {
                throw new Error(
                    "Ранг не найден"
                );
            }

            const user = userResult.rows[0];
            const rank = rankResult.rows[0];

            const already = await client.query(
                `
                SELECT id
                FROM user_ranks
                WHERE user_id::TEXT = $1
                  AND rank_id::TEXT = $2
                LIMIT 1
                `,
                [
                    String(user.id),
                    rankId
                ]
            );

            if (already.rowCount) {
                throw new Error(
                    "Этот ранг уже куплен"
                );
            }

            const price = Number(
                rank.price || 0
            );

            if (
                Number(user.balance || 0) <
                price
            ) {
                throw new Error(
                    "Недостаточно средств"
                );
            }

            await client.query(
                `
                UPDATE users
                SET balance = balance - $1
                WHERE id::TEXT = $2
                `,
                [
                    price,
                    String(user.id)
                ]
            );

            await client.query(
                `
                INSERT INTO user_ranks
                    (id, user_id, rank_id)
                VALUES
                    ($1,$2,$3)
                `,
                [
                    id(),
                    String(user.id),
                    rankId
                ]
            );

            await client.query("COMMIT");

            const updated = await getUser(
                user.id
            );

            io.emit("leaderboard:update");

            res.json({
                user: publicUser(updated)
            });
        } catch (err) {
            await client.query("ROLLBACK");

            res.status(400).json({
                error: err.message
            });
        } finally {
            client.release();
        }
    }
);

/*
==================================================
QUESTS
==================================================
*/

app.get("/api/quests", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                title,
                description,
                reward,
                xp
            FROM quests
            ORDER BY created_at DESC
        `);

        res.json({
            quests: result.rows.map(q => ({
                id: String(q.id),
                questId: String(q.id),
                title: q.title,
                description: q.description,
                reward: Number(q.reward || 0),
                xp: Number(q.xp || 0)
            }))
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: "Ошибка загрузки квестов"
        });
    }
});

app.post(
    "/api/quests/:id/claim",
    auth,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const questId = String(
                req.params.id
            );

            const questResult =
                await client.query(
                    `
                    SELECT *
                    FROM quests
                    WHERE id::TEXT = $1
                    LIMIT 1
                    `,
                    [questId]
                );

            if (!questResult.rowCount) {
                throw new Error(
                    "Квест не найден"
                );
            }

            const claimed =
                await client.query(
                    `
                    SELECT id
                    FROM claimed_quests
                    WHERE user_id::TEXT = $1
                      AND quest_id::TEXT = $2
                    LIMIT 1
                    `,
                    [
                        String(req.user.id),
                        questId
                    ]
                );

            if (claimed.rowCount) {
                throw new Error(
                    "Этот квест уже выполнен"
                );
            }

            const quest =
                questResult.rows[0];

            await client.query(
                `
                INSERT INTO claimed_quests
                    (id,user_id,quest_id)
                VALUES
                    ($1,$2,$3)
                `,
                [
                    id(),
                    String(req.user.id),
                    questId
                ]
            );

            await client.query(
                `
                UPDATE users
                SET
                    balance = balance + $1,
                    xp = xp + $2
                WHERE id::TEXT = $3
                `,
                [
                    Number(quest.reward || 0),
                    Number(quest.xp || 0),
                    String(req.user.id)
                ]
            );

            await client.query("COMMIT");

            const user =
                await getUser(req.user.id);

            io.emit("leaderboard:update");

            res.json({
                reward: Number(
                    quest.reward || 0
                ),
                xp: Number(
                    quest.xp || 0
                ),
                user: publicUser(user)
            });
        } catch (err) {
            await client.query("ROLLBACK");

            res.status(400).json({
                error: err.message
            });
        } finally {
            client.release();
        }
    }
);

/*
==================================================
LEADERBOARD
==================================================
*/

app.get(
    "/api/leaderboard",
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    id,
                    username,
                    elo,
                    xp,
                    wins
                FROM users
                ORDER BY elo DESC, wins DESC, xp DESC
                LIMIT 100
            `);

            res.json({
                players: result.rows.map(p => ({
                    id: String(p.id),
                    username: p.username,
                    elo: Number(p.elo || 0),
                    xp: Number(p.xp || 0),
                    wins: Number(p.wins || 0)
                }))
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error: "Ошибка рейтинга"
            });
        }
    }
);

/*
==================================================
ADMIN USERS
==================================================
*/

app.get(
    "/api/admin/users",
    auth,
    admin,
    async (req, res) => {
        try {
            const search = clean(
                req.query.search || "",
                100
            );

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
                    is_admin
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
                users: result.rows.map(u => ({
                    id: String(u.id),
                    username: u.username,
                    email: u.email,
                    balance: Number(
                        u.balance || 0
                    ),
                    elo: Number(
                        u.elo || 0
                    ),
                    xp: Number(
                        u.xp || 0
                    ),
                    wins: Number(
                        u.wins || 0
                    ),
                    is_admin: Boolean(
                        u.is_admin
                    )
                }))
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка загрузки игроков"
            });
        }
    }
);

app.put(
    "/api/admin/users/:id",
    auth,
    admin,
    async (req, res) => {
        try {
            const userId = String(
                req.params.id
            );

            const elo = Math.max(
                0,
                Math.floor(
                    number(req.body.elo)
                )
            );

            const wins = Math.max(
                0,
                Math.floor(
                    number(req.body.wins)
                )
            );

            const balance = Math.max(
                0,
                Math.floor(
                    number(req.body.balance)
                )
            );

            const xp = Math.max(
                0,
                Math.floor(
                    number(
                        req.body.xp,
                        0
                    )
                )
            );

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET
                        elo = $1,
                        wins = $2,
                        balance = $3,
                        xp = $4
                    WHERE id::TEXT = $5
                    RETURNING *
                    `,
                    [
                        elo,
                        wins,
                        balance,
                        xp,
                        userId
                    ]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Игрок не найден"
                });
            }

            io.emit(
                "leaderboard:update"
            );

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка изменения игрока"
            });
        }
    }
);

/*
==================================================
ADMIN RANKS
==================================================
*/

app.get(
    "/api/admin/ranks",
    auth,
    admin,
    async (req, res) => {
        try {
            const result =
                await pool.query(`
                    SELECT
                        id,
                        id AS "rankId",
                        name,
                        title,
                        price,
                        color,
                        icon
                    FROM ranks
                    ORDER BY price ASC
                `);

            res.json({
                ranks: result.rows.map(r => ({
                    id: String(r.id),
                    rankId: String(
                        r.rankId
                    ),
                    name: r.name,
                    title: r.title,
                    price: Number(
                        r.price || 0
                    ),
                    color: r.color,
                    icon: r.icon
                }))
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка загрузки рангов"
            });
        }
    }
);

app.post(
    "/api/admin/ranks",
    auth,
    admin,
    async (req, res) => {
        try {
            const rankId = clean(
                req.body.rankId,
                50
            );

            const name = clean(
                req.body.name,
                100
            );

            const title = clean(
                req.body.title,
                150
            );

            const price = Math.max(
                0,
                Math.floor(
                    number(req.body.price)
                )
            );

            const color = clean(
                req.body.color || "#9b7cff",
                30
            );

            const icon = clean(
                req.body.icon || "★",
                10
            );

            if (!rankId || !name) {
                return res.status(400).json({
                    error:
                        "ID и название ранга обязательны"
                });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM ranks
                    WHERE id::TEXT = $1
                    LIMIT 1
                    `,
                    [rankId]
                );

            if (exists.rowCount) {
                return res.status(400).json({
                    error:
                        "Такой ранг уже существует"
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO ranks
                        (
                            id,
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

            io.emit("ranks:update");

            res.json({
                rank: result.rows[0]
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка создания ранга"
            });
        }
    }
);

app.delete(
    "/api/admin/ranks/:id",
    auth,
    admin,
    async (req, res) => {
        try {
            const rankId = String(
                req.params.id
            );

            /*
             * Сначала удаляем владение рангом,
             * затем сам ранг.
             */

            await pool.query(
                `
                DELETE FROM user_ranks
                WHERE rank_id::TEXT = $1
                `,
                [rankId]
            );

            const result =
                await pool.query(
                    `
                    DELETE FROM ranks
                    WHERE id::TEXT = $1
                    RETURNING id
                    `,
                    [rankId]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Ранг не найден"
                });
            }

            io.emit("ranks:update");

            res.json({
                success: true
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка удаления ранга"
            });
        }
    }
);

/*
==================================================
ADMIN QUESTS
==================================================
*/

app.get(
    "/api/admin/quests",
    auth,
    admin,
    async (req, res) => {
        try {
            const result =
                await pool.query(`
                    SELECT
                        id,
                        title,
                        description,
                        reward,
                        xp
                    FROM quests
                    ORDER BY created_at DESC
                `);

            res.json({
                quests: result.rows.map(q => ({
                    id: String(q.id),
                    questId: String(
                        q.id
                    ),
                    title: q.title,
                    description:
                        q.description,
                    reward: Number(
                        q.reward || 0
                    ),
                    xp: Number(
                        q.xp || 0
                    )
                }))
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка загрузки квестов"
            });
        }
    }
);

app.post(
    "/api/admin/quests",
    auth,
    admin,
    async (req, res) => {
        try {
            const questId = clean(
                req.body.questId,
                50
            );

            const title = clean(
                req.body.title,
                150
            );

            const description = clean(
                req.body.description,
                500
            );

            const reward = Math.max(
                0,
                Math.floor(
                    number(
                        req.body.reward
                    )
                )
            );

            const xp = Math.max(
                0,
                Math.floor(
                    number(
                        req.body.xp
                    )
                )
            );

            if (!questId || !title) {
                return res.status(400).json({
                    error:
                        "ID и название квеста обязательны"
                });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM quests
                    WHERE id::TEXT = $1
                    LIMIT 1
                    `,
                    [questId]
                );

            if (exists.rowCount) {
                return res.status(400).json({
                    error:
                        "Такой квест уже существует"
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO quests
                        (
                            id,
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

            io.emit("quests:update");

            res.json({
                quest: result.rows[0]
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка создания квеста"
            });
        }
    }
);

app.delete(
    "/api/admin/quests/:id",
    auth,
    admin,
    async (req, res) => {
        try {
            const questId = String(
                req.params.id
            );

            await pool.query(
                `
                DELETE FROM claimed_quests
                WHERE quest_id::TEXT = $1
                `,
                [questId]
            );

            const result =
                await pool.query(
                    `
                    DELETE FROM quests
                    WHERE id::TEXT = $1
                    RETURNING id
                    `,
                    [questId]
                );

            if (!result.rowCount) {
                return res.status(404).json({
                    error:
                        "Квест не найден"
                });
            }

            io.emit("quests:update");

            res.json({
                success: true
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка удаления квеста"
            });
        }
    }
);

/*
==================================================
ADMIN RANK FOR USER
==================================================
*/

app.post(
    "/api/admin/users/:id/rank",
    auth,
    admin,
    async (req, res) => {
        try {
            const userId = String(
                req.params.id
            );

            const rankId = String(
                req.body.rankId || ""
            );

            const user =
                await getUser(userId);

            if (!user) {
                return res.status(404).json({
                    error:
                        "Игрок не найден"
                });
            }

            const rank =
                await pool.query(
                    `
                    SELECT id
                    FROM ranks
                    WHERE id::TEXT = $1
                    LIMIT 1
                    `,
                    [rankId]
                );

            if (!rank.rowCount) {
                return res.status(404).json({
                    error:
                        "Ранг не найден"
                });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM user_ranks
                    WHERE user_id::TEXT = $1
                      AND rank_id::TEXT = $2
                    `,
                    [
                        userId,
                        rankId
                    ]
                );

            if (!exists.rowCount) {
                await pool.query(
                    `
                    INSERT INTO user_ranks
                        (id,user_id,rank_id)
                    VALUES
                        ($1,$2,$3)
                    `,
                    [
                        id(),
                        userId,
                        rankId
                    ]
                );
            }

            res.json({
                success: true
            });

            io.emit("leaderboard:update");
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка выдачи ранга"
            });
        }
    }
);

app.delete(
    "/api/admin/users/:id/rank/:rankId",
    auth,
    admin,
    async (req, res) => {
        try {
            await pool.query(
                `
                DELETE FROM user_ranks
                WHERE user_id::TEXT = $1
                  AND rank_id::TEXT = $2
                `,
                [
                    String(
                        req.params.id
                    ),
                    String(
                        req.params.rankId
                    )
                ]
            );

            res.json({
                success: true
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                error:
                    "Ошибка снятия ранга"
            });
        }
    }
);

/*
==================================================
HEALTH
==================================================
*/

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            ok: true,
            service: "ASTRO ONLINE"
        });
    } catch {
        res.status(500).json({
            ok: false
        });
    }
});

/*
==================================================
SOCKET
==================================================
*/

io.on("connection", socket => {
    console.log(
        "ASTRO: подключён клиент",
        socket.id
    );

    socket.on("disconnect", () => {
        console.log(
            "ASTRO: клиент отключён",
            socket.id
        );
    });
});

/*
==================================================
404 API
==================================================
*/

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API маршрут не найден"
    });
});

/*
==================================================
START
==================================================
*/

async function start() {
    try {
        await initDatabase();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log("");
                console.log(
                    "========================================"
                );
                console.log(
                    "🚀 ASTRO ONLINE ЗАПУЩЕН"
                );
                console.log(
                    "========================================"
                );
                console.log(
                    "PORT:",
                    PORT
                );
                console.log(
                    "ADMIN:",
                    "admin@astro.online"
                );
                console.log(
                    "========================================"
                );
            }
        );
    } catch (err) {
        console.error("");
        console.error(
            "========================================"
        );
        console.error(
            "FATAL SERVER ERROR:"
        );
        console.error(err);
        console.error(
            "========================================"
        );
        console.error("");

        process.exit(1);
    }
}

process.on(
    "unhandledRejection",
    err => {
        console.error(
            "UNHANDLED REJECTION:",
            err
        );
    }
);

process.on(
    "uncaughtException",
    err => {
        console.error(
            "UNCAUGHT EXCEPTION:",
            err
        );
    }
);

start();
```
