const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("FATAL SERVER ERROR: DATABASE_URL не задан.");
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

function randomToken() {
    return crypto.randomBytes(48).toString("hex");
}

function hashPassword(password, salt) {
    return crypto
        .createHash("sha256")
        .update(String(salt) + ":" + String(password))
        .digest("hex");
}

function createPassword(password) {
    const salt = crypto.randomBytes(24).toString("hex");
    const hash = hashPassword(password, salt);

    return {
        salt,
        hash
    };
}

function checkPassword(password, salt, hash) {
    const calculated = hashPassword(password, salt);

    const a = Buffer.from(calculated, "hex");
    const b = Buffer.from(String(hash), "hex");

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function number(value, fallback = 0) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return fallback;
    }

    return n;
}

function integer(value, fallback = 0) {
    const n = Math.trunc(Number(value));

    if (!Number.isFinite(n)) {
        return fallback;
    }

    return n;
}

function publicUser(row) {
    if (!row) {
        return null;
    }

    return {
        id: String(row.id),
        username: row.username,
        email: row.email,
        balance: Number(row.balance || 0),
        elo: Number(row.elo || 0),
        xp: Number(row.xp || 0),
        wins: Number(row.wins || 0),
        rankId: row.rank_id ? String(row.rank_id) : null,
        rankName: row.rank_name || null,
        rankTitle: row.rank_title || null,
        rankColor: row.rank_color || null,
        rankIcon: row.rank_icon || null,
        ownedRanks: Array.isArray(row.owned_ranks)
            ? row.owned_ranks.map(String)
            : [],
        createdAt: row.created_at
    };
}

function publicRank(row) {
    return {
        id: String(row.id),
        rankId: row.rank_id,
        name: row.name,
        title: row.title,
        price: Number(row.price || 0),
        color: row.color || "#9b7cff",
        icon: row.icon || "★"
    };
}

function publicQuest(row) {
    return {
        id: String(row.id),
        questId: row.quest_id,
        title: row.title,
        description: row.description,
        reward: Number(row.reward || 0),
        xp: Number(row.xp || 0),
        active: Boolean(row.active)
    };
}

async function query(text, params = []) {
    return pool.query(text, params);
}

async function getUserById(id) {
    const result = await query(
        `
        SELECT
            u.*,
            r.name AS rank_name,
            r.title AS rank_title,
            r.color AS rank_color,
            r.icon AS rank_icon
        FROM users u
        LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE u.id = $1
        LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function getUserByEmail(email) {
    const result = await query(
        `
        SELECT
            u.*,
            r.name AS rank_name,
            r.title AS rank_title,
            r.color AS rank_color,
            r.icon AS rank_icon
        FROM users u
        LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE LOWER(u.email) = LOWER($1)
        LIMIT 1
        `,
        [email]
    );

    return result.rows[0] || null;
}

async function getUserByUsername(username) {
    const result = await query(
        `
        SELECT
            u.*,
            r.name AS rank_name,
            r.title AS rank_title,
            r.color AS rank_color,
            r.icon AS rank_icon
        FROM users u
        LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE LOWER(u.username) = LOWER($1)
        LIMIT 1
        `,
        [username]
    );

    return result.rows[0] || null;
}

async function getUserFromToken(token) {
    if (!token) {
        return null;
    }

    const result = await query(
        `
        SELECT
            u.*,
            r.name AS rank_name,
            r.title AS rank_title,
            r.color AS rank_color,
            r.icon AS rank_icon
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE s.token = $1
          AND s.expires_at > NOW()
        LIMIT 1
        `,
        [token]
    );

    return result.rows[0] || null;
}

function getToken(req) {
    const header = req.headers.authorization || "";

    if (header.toLowerCase().startsWith("bearer ")) {
        return header.slice(7).trim();
    }

    if (req.body && req.body.token) {
        return clean(req.body.token);
    }

    if (req.query && req.query.token) {
        return clean(req.query.token);
    }

    return "";
}

async function auth(req, res, next) {
    try {
        const token = getToken(req);
        const user = await getUserFromToken(token);

        if (!user) {
            return res.status(401).json({
                error: "Необходима авторизация."
            });
        }

        req.token = token;
        req.user = user;

        next();
    } catch (error) {
        console.error("AUTH ERROR:", error);

        res.status(500).json({
            error: "Ошибка авторизации."
        });
    }
}

function isAdminUser(user) {
    if (!user) {
        return false;
    }

    if (Boolean(user.is_admin)) {
        return true;
    }

    const adminEmail = clean(process.env.ADMIN_EMAIL);

    if (
        adminEmail &&
        user.email &&
        user.email.toLowerCase() === adminEmail.toLowerCase()
    ) {
        return true;
    }

    return false;
}

async function admin(req, res, next) {
    try {
        const token = getToken(req);
        const user = await getUserFromToken(token);

        if (!user) {
            return res.status(401).json({
                error: "Сначала войдите в аккаунт."
            });
        }

        if (!isAdminUser(user)) {
            return res.status(403).json({
                error: "Доступ к админке запрещён."
            });
        }

        req.token = token;
        req.user = user;

        next();
    } catch (error) {
        console.error("ADMIN AUTH ERROR:", error);

        res.status(500).json({
            error: "Ошибка проверки администратора."
        });
    }
}

async function initDatabase() {
    console.log("ASTRO: подключение к PostgreSQL...");

    await query("SELECT NOW()");

    console.log("ASTRO: PostgreSQL подключен.");

    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(40) NOT NULL,
            email VARCHAR(255) NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            balance BIGINT NOT NULL DEFAULT 10000,
            elo BIGINT NOT NULL DEFAULT 1000,
            xp BIGINT NOT NULL DEFAULT 0,
            wins BIGINT NOT NULL DEFAULT 0,
            rank_id BIGINT,
            is_admin BOOLEAN NOT NULL DEFAULT FALSE,
            owned_ranks BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
        ON users (LOWER(email))
    `);

    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx
        ON users (LOWER(username))
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id BIGSERIAL PRIMARY KEY,
            rank_id VARCHAR(80) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            title VARCHAR(150) NOT NULL DEFAULT '',
            price BIGINT NOT NULL DEFAULT 0,
            color VARCHAR(30) NOT NULL DEFAULT '#9b7cff',
            icon VARCHAR(20) NOT NULL DEFAULT '★',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS quests (
            id BIGSERIAL PRIMARY KEY,
            quest_id VARCHAR(80) NOT NULL UNIQUE,
            title VARCHAR(150) NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            reward BIGINT NOT NULL DEFAULT 0,
            xp BIGINT NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS quest_claims (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
            claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, quest_id)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS sessions_token_idx
        ON sessions(token)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS sessions_user_idx
        ON sessions(user_id)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS users_elo_idx
        ON users(elo DESC)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS users_xp_idx
        ON users(xp DESC)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS quest_claims_user_idx
        ON quest_claims(user_id)
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT 10000
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS elo BIGINT NOT NULL DEFAULT 1000
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS wins BIGINT NOT NULL DEFAULT 0
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS owned_ranks BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[]
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS rank_id BIGINT
    `);

    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ranks_rank_id_unique_idx
        ON ranks(rank_id)
    `);

    const oldRanks = await query(`
        SELECT id, rank_id
        FROM ranks
        ORDER BY id ASC
    `);

    for (const rank of oldRanks.rows) {
        const rankId = Number(rank.id);

        await query(
            `
            UPDATE users
            SET owned_ranks = ARRAY(
                SELECT DISTINCT x
                FROM unnest(
                    COALESCE(owned_ranks, ARRAY[]::BIGINT[])
                ) AS x
                WHERE x = $1
            )
            WHERE FALSE
            `,
            [rankId]
        );
    }

    await query(`
        INSERT INTO ranks
            (rank_id, name, title, price, color, icon)
        VALUES
            ('bronze', 'BRONZE', 'Бронзовый', 1000, '#cd7f32', '🥉'),
            ('silver', 'SILVER', 'Серебряный', 5000, '#c0c0c0', '🥈'),
            ('gold', 'GOLD', 'Золотой', 15000, '#ffd700', '🥇'),
            ('diamond', 'DIAMOND', 'Алмазный', 30000, '#55ddff', '💎'),
            ('master', 'MASTER', 'Мастер', 60000, '#c66cff', '👑')
        ON CONFLICT (rank_id) DO NOTHING
    `);

    await query(`
        INSERT INTO quests
            (quest_id, title, description, reward, xp, active)
        VALUES
            (
                'first-win',
                'Первая победа',
                'Одержи свою первую победу.',
                1000,
                100,
                TRUE
            ),
            (
                'elo-1500',
                'Путь к вершине',
                'Достигни 1500 ELO.',
                3000,
                300,
                TRUE
            ),
            (
                'elo-2000',
                'Космическая легенда',
                'Достигни 2000 ELO.',
                10000,
                1000,
                TRUE
            )
        ON CONFLICT (quest_id) DO NOTHING
    `);

    const adminEmail = clean(process.env.ADMIN_EMAIL);
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (adminEmail && adminPassword) {
        const existingAdmin = await getUserByEmail(adminEmail);

        if (!existingAdmin) {
            const credentials = createPassword(adminPassword);

            await query(
                `
                INSERT INTO users
                    (
                        username,
                        email,
                        password_hash,
                        password_salt,
                        balance,
                        elo,
                        xp,
                        wins,
                        is_admin
                    )
                VALUES
                    ($1, $2, $3, $4, 1000000, 5000, 0, 0, TRUE)
                `,
                [
                    "Administrator",
                    adminEmail,
                    credentials.hash,
                    credentials.salt
                ]
            );

            console.log("ASTRO: администратор создан:", adminEmail);
        } else {
            await query(
                `
                UPDATE users
                SET is_admin = TRUE
                WHERE id = $1
                `,
                [existingAdmin.id]
            );

            console.log("ASTRO: права администратора подтверждены.");
        }
    } else {
        console.log(
            "ASTRO: ADMIN_EMAIL / ADMIN_PASSWORD не заданы. " +
            "Первый зарегистрированный пользователь НЕ будет автоматически админом."
        );
    }

    await query(`
        DELETE FROM sessions
        WHERE expires_at <= NOW()
    `);

    console.log("ASTRO: база данных готова.");
}

app.get("/api/health", async (req, res) => {
    try {
        await query("SELECT 1");

        res.json({
            ok: true,
            server: "ASTRO ONLINE",
            database: "connected",
            time: new Date().toISOString()
        });
    } catch (error) {
        console.error("HEALTH ERROR:", error);

        res.status(500).json({
            ok: false,
            database: "error"
        });
    }
});

app.post("/api/register", async (req, res) => {
    try {
        const username = clean(req.body.username);
        const email = clean(req.body.email).toLowerCase();
        const password = String(req.body.password || "");

        if (username.length < 3 || username.length > 40) {
            return res.status(400).json({
                error: "Никнейм должен содержать от 3 до 40 символов."
            });
        }

        if (!/^[a-zA-Z0-9а-яА-ЯёЁ_ -]+$/.test(username)) {
            return res.status(400).json({
                error: "В никнейме есть недопустимые символы."
            });
        }

        if (!email.includes("@") || email.length > 255) {
            return res.status(400).json({
                error: "Введите корректный Email."
            });
        }

        if (password.length < 6 || password.length > 200) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 6 символов."
            });
        }

        const existingEmail = await getUserByEmail(email);

        if (existingEmail) {
            return res.status(409).json({
                error: "Этот Email уже зарегистрирован."
            });
        }

        const existingUsername = await getUserByUsername(username);

        if (existingUsername) {
            return res.status(409).json({
                error: "Этот никнейм уже занят."
            });
        }

        const credentials = createPassword(password);

        const result = await query(
            `
            INSERT INTO users
                (
                    username,
                    email,
                    password_hash,
                    password_salt
                )
            VALUES
                ($1, $2, $3, $4)
            RETURNING id
            `,
            [
                username,
                email,
                credentials.hash,
                credentials.salt
            ]
        );

        const user = await getUserById(result.rows[0].id);

        const token = randomToken();

        await query(
            `
            INSERT INTO sessions
                (user_id, token, expires_at)
            VALUES
                ($1, $2, NOW() + INTERVAL '30 days')
            `,
            [user.id, token]
        );

        res.status(201).json({
            success: true,
            token,
            user: publicUser(user)
        });
    } catch (error) {
        console.error("REGISTER ERROR:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Email или никнейм уже используется."
            });
        }

        res.status(500).json({
            error: "Ошибка регистрации."
        });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const email = clean(req.body.email).toLowerCase();
        const password = String(req.body.password || "");

        if (!email || !password) {
            return res.status(400).json({
                error: "Введите Email и пароль."
            });
        }

        const user = await getUserByEmail(email);

        if (!user) {
            return res.status(401).json({
                error: "Неверный Email или пароль."
            });
        }

        const valid = checkPassword(
            password,
            user.password_salt,
            user.password_hash
        );

        if (!valid) {
            return res.status(401).json({
                error: "Неверный Email или пароль."
            });
        }

        const token = randomToken();

        await query(
            `
            INSERT INTO sessions
                (user_id, token, expires_at)
            VALUES
                ($1, $2, NOW() + INTERVAL '30 days')
            `,
            [user.id, token]
        );

        res.json({
            success: true,
            token,
            user: publicUser(user)
        });
    } catch (error) {
        console.error("LOGIN ERROR:", error);

        res.status(500).json({
            error: "Ошибка входа."
        });
    }
});

app.post("/api/logout", auth, async (req, res) => {
    try {
        await query(
            `
            DELETE FROM sessions
            WHERE token = $1
            `,
            [req.token]
        );

        res.json({
            success: true
        });
    } catch (error) {
        console.error("LOGOUT ERROR:", error);

        res.status(500).json({
            error: "Ошибка выхода."
        });
    }
});

app.get("/api/me", auth, async (req, res) => {
    try {
        const user = await getUserById(req.user.id);

        res.json({
            success: true,
            user: publicUser(user)
        });
    } catch (error) {
        console.error("ME ERROR:", error);

        res.status(500).json({
            error: "Ошибка получения профиля."
        });
    }
});

app.get("/api/ranks", async (req, res) => {
    try {
        const result = await query(`
            SELECT *
            FROM ranks
            ORDER BY price ASC, id ASC
        `);

        res.json({
            success: true,
            ranks: result.rows.map(publicRank)
        });
    } catch (error) {
        console.error("RANKS ERROR:", error);

        res.status(500).json({
            error: "Не удалось загрузить ранги."
        });
    }
});

app.post("/api/ranks/:rankId/buy", auth, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const rankResult = await client.query(
            `
            SELECT *
            FROM ranks
            WHERE rank_id = $1
            LIMIT 1
            FOR UPDATE
            `,
            [clean(req.params.rankId)]
        );

        if (!rankResult.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        const rank = rankResult.rows[0];

        const userResult = await client.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
            `,
            [req.user.id]
        );

        const user = userResult.rows[0];

        const owned = Array.isArray(user.owned_ranks)
            ? user.owned_ranks.map(Number)
            : [];

        if (owned.includes(Number(rank.id))) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Этот ранг уже куплен."
            });
        }

        const balance = Number(user.balance || 0);
        const price = Number(rank.price || 0);

        if (balance < price) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Недостаточно денег."
            });
        }

        const newBalance = balance - price;

        await client.query(
            `
            UPDATE users
            SET
                balance = $1,
                rank_id = $2,
                owned_ranks = ARRAY(
                    SELECT DISTINCT x
                    FROM unnest(
                        COALESCE(owned_ranks, ARRAY[]::BIGINT[])
                        || ARRAY[$2::BIGINT]
                    ) AS x
                )
            WHERE id = $3
            `,
            [
                newBalance,
                rank.id,
                user.id
            ]
        );

        await client.query("COMMIT");

        const updated = await getUserById(user.id);

        io.emit("leaderboard:update");
        io.emit("ranks:update");

        res.json({
            success: true,
            message: "Ранг куплен.",
            user: publicUser(updated),
            rank: publicRank(rank)
        });
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("BUY RANK ERROR:", error);

        res.status(500).json({
            error: "Ошибка покупки ранга."
        });
    } finally {
        client.release();
    }
});

app.get("/api/quests", async (req, res) => {
    try {
        const result = await query(`
            SELECT *
            FROM quests
            WHERE active = TRUE
            ORDER BY id DESC
        `);

        res.json({
            success: true,
            quests: result.rows.map(publicQuest)
        });
    } catch (error) {
        console.error("QUESTS ERROR:", error);

        res.status(500).json({
            error: "Не удалось загрузить квесты."
        });
    }
});

app.post("/api/quests/:questId/claim", auth, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const questResult = await client.query(
            `
            SELECT *
            FROM quests
            WHERE quest_id = $1
              AND active = TRUE
            LIMIT 1
            FOR UPDATE
            `,
            [clean(req.params.questId)]
        );

        if (!questResult.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Квест не найден."
            });
        }

        const quest = questResult.rows[0];

        const already = await client.query(
            `
            SELECT id
            FROM quest_claims
            WHERE user_id = $1
              AND quest_id = $2
            LIMIT 1
            `,
            [req.user.id, quest.id]
        );

        if (already.rows.length) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Этот квест уже выполнен."
            });
        }

        const userResult = await client.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            FOR UPDATE
            `,
            [req.user.id]
        );

        const user = userResult.rows[0];

        if (quest.quest_id === "first-win" && Number(user.wins) < 1) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Сначала одержите победу."
            });
        }

        if (
            quest.quest_id === "elo-1500" &&
            Number(user.elo) < 1500
        ) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Сначала достигните 1500 ELO."
            });
        }

        if (
            quest.quest_id === "elo-2000" &&
            Number(user.elo) < 2000
        ) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Сначала достигните 2000 ELO."
            });
        }

        await client.query(
            `
            INSERT INTO quest_claims
                (user_id, quest_id)
            VALUES
                ($1, $2)
            `,
            [user.id, quest.id]
        );

        await client.query(
            `
            UPDATE users
            SET
                balance = balance + $1,
                xp = xp + $2
            WHERE id = $3
            `,
            [
                Number(quest.reward || 0),
                Number(quest.xp || 0),
                user.id
            ]
        );

        await client.query("COMMIT");

        const updated = await getUserById(user.id);

        io.emit("leaderboard:update");

        res.json({
            success: true,
            reward: Number(quest.reward || 0),
            xp: Number(quest.xp || 0),
            user: publicUser(updated)
        });
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("CLAIM QUEST ERROR:", error);

        if (error.code === "23505") {
            return res.status(400).json({
                error: "Этот квест уже выполнен."
            });
        }

        res.status(500).json({
            error: "Ошибка выполнения квеста."
        });
    } finally {
        client.release();
    }
});

app.get("/api/leaderboard", async (req, res) => {
    try {
        const result = await query(`
            SELECT
                u.id,
                u.username,
                u.elo,
                u.xp,
                u.wins,
                u.rank_id,
                r.name AS rank_name,
                r.title AS rank_title,
                r.color AS rank_color,
                r.icon AS rank_icon
            FROM users u
            LEFT JOIN ranks r ON r.id = u.rank_id
            ORDER BY
                u.elo DESC,
                u.xp DESC,
                u.wins DESC,
                u.id ASC
            LIMIT 100
        `);

        res.json({
            success: true,
            players: result.rows.map((row, index) => ({
                id: String(row.id),
                position: index + 1,
                username: row.username,
                elo: Number(row.elo || 0),
                xp: Number(row.xp || 0),
                wins: Number(row.wins || 0),
                rankId: row.rank_id ? String(row.rank_id) : null,
                rankName: row.rank_name || null,
                rankTitle: row.rank_title || null,
                rankColor: row.rank_color || null,
                rankIcon: row.rank_icon || null
            }))
        });
    } catch (error) {
        console.error("LEADERBOARD ERROR:", error);

        res.status(500).json({
            error: "Не удалось загрузить рейтинг."
        });
    }
});

app.get("/api/admin/users", admin, async (req, res) => {
    try {
        const search = clean(req.query.search);

        let result;

        if (search) {
            result = await query(
                `
                SELECT
                    u.*,
                    r.name AS rank_name,
                    r.title AS rank_title,
                    r.color AS rank_color,
                    r.icon AS rank_icon
                FROM users u
                LEFT JOIN ranks r ON r.id = u.rank_id
                WHERE
                    u.username ILIKE $1
                    OR u.email ILIKE $1
                ORDER BY u.elo DESC
                LIMIT 100
                `,
                ["%" + search + "%"]
            );
        } else {
            result = await query(`
                SELECT
                    u.*,
                    r.name AS rank_name,
                    r.title AS rank_title,
                    r.color AS rank_color,
                    r.icon AS rank_icon
                FROM users u
                LEFT JOIN ranks r ON r.id = u.rank_id
                ORDER BY u.elo DESC
                LIMIT 100
            `);
        }

        res.json({
            success: true,
            users: result.rows.map(publicUser)
        });
    } catch (error) {
        console.error("ADMIN USERS ERROR:", error);

        res.status(500).json({
            error: "Не удалось загрузить игроков."
        });
    }
});

app.put("/api/admin/users/:id", admin, async (req, res) => {
    try {
        const id = integer(req.params.id, 0);

        if (!id) {
            return res.status(400).json({
                error: "Неверный ID игрока."
            });
        }

        const current = await getUserById(id);

        if (!current) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        const elo = Math.max(0, integer(req.body.elo, Number(current.elo)));
        const xp = Math.max(0, integer(req.body.xp, Number(current.xp)));
        const wins = Math.max(0, integer(req.body.wins, Number(current.wins)));
        const balance = Math.max(
            0,
            integer(req.body.balance, Number(current.balance))
        );

        let rankId = current.rank_id;

        if (
            req.body.rankId !== undefined &&
            req.body.rankId !== null &&
            clean(req.body.rankId) !== ""
        ) {
            const rank = await query(
                `
                SELECT id
                FROM ranks
                WHERE rank_id = $1
                LIMIT 1
                `,
                [clean(req.body.rankId)]
            );

            if (!rank.rows.length) {
                return res.status(400).json({
                    error: "Указанный ранг не найден."
                });
            }

            rankId = rank.rows[0].id;
        }

        await query(
            `
            UPDATE users
            SET
                elo = $1,
                xp = $2,
                wins = $3,
                balance = $4,
                rank_id = $5
            WHERE id = $6
            `,
            [
                elo,
                xp,
                wins,
                balance,
                rankId,
                id
            ]
        );

        const updated = await getUserById(id);

        io.emit("leaderboard:update");

        res.json({
            success: true,
            user: publicUser(updated)
        });
    } catch (error) {
        console.error("ADMIN UPDATE USER ERROR:", error);

        res.status(500).json({
            error: "Не удалось сохранить игрока."
        });
    }
});

app.post("/api/admin/users/:id/give", admin, async (req, res) => {
    try {
        const id = integer(req.params.id, 0);

        const user = await getUserById(id);

        if (!user) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        const eloAdd = integer(req.body.elo, 0);
        const xpAdd = integer(req.body.xp, 0);
        const winsAdd = integer(req.body.wins, 0);
        const moneyAdd = integer(req.body.balance, 0);

        await query(
            `
            UPDATE users
            SET
                elo = GREATEST(0, elo + $1),
                xp = GREATEST(0, xp + $2),
                wins = GREATEST(0, wins + $3),
                balance = GREATEST(0, balance + $4)
            WHERE id = $5
            `,
            [
                eloAdd,
                xpAdd,
                winsAdd,
                moneyAdd,
                id
            ]
        );

        const updated = await getUserById(id);

        io.emit("leaderboard:update");

        res.json({
            success: true,
            user: publicUser(updated)
        });
    } catch (error) {
        console.error("ADMIN GIVE ERROR:", error);

        res.status(500).json({
            error: "Ошибка выдачи."
        });
    }
});

app.get("/api/admin/ranks", admin, async (req, res) => {
    try {
        const result = await query(`
            SELECT *
            FROM ranks
            ORDER BY price ASC, id ASC
        `);

        res.json({
            success: true,
            ranks: result.rows.map(publicRank)
        });
    } catch (error) {
        console.error("ADMIN RANKS ERROR:", error);

        res.status(500).json({
            error: "Ошибка загрузки рангов."
        });
    }
});

app.post("/api/admin/ranks", admin, async (req, res) => {
    try {
        const rankId = clean(req.body.rankId);
        const name = clean(req.body.name);
        const title = clean(req.body.title);
        const price = Math.max(0, integer(req.body.price, 0));
        const color = clean(req.body.color) || "#9b7cff";
        const icon = clean(req.body.icon) || "★";

        if (!rankId || !name) {
            return res.status(400).json({
                error: "ID и название ранга обязательны."
            });
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(rankId)) {
            return res.status(400).json({
                error: "ID ранга может содержать только буквы, цифры, _ и -."
            });
        }

        const result = await query(
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

        res.status(201).json({
            success: true,
            rank: publicRank(result.rows[0])
        });
    } catch (error) {
        console.error("ADMIN CREATE RANK ERROR:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ранг с таким ID уже существует."
            });
        }

        res.status(500).json({
            error: "Ошибка создания ранга."
        });
    }
});

app.delete("/api/admin/ranks/:id", admin, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const id = integer(req.params.id, 0);

        const rankResult = await client.query(
            `
            SELECT *
            FROM ranks
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
            `,
            [id]
        );

        if (!rankResult.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        await client.query(
            `
            UPDATE users
            SET rank_id = NULL
            WHERE rank_id = $1
            `,
            [id]
        );

        await client.query(
            `
            UPDATE users
            SET owned_ranks = array_remove(
                COALESCE(owned_ranks, ARRAY[]::BIGINT[]),
                $1::BIGINT
            )
            `,
            [id]
        );

        await client.query(
            `
            DELETE FROM ranks
            WHERE id = $1
            `,
            [id]
        );

        await client.query("COMMIT");

        io.emit("ranks:update");
        io.emit("leaderboard:update");

        res.json({
            success: true
        });
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("ADMIN DELETE RANK ERROR:", error);

        res.status(500).json({
            error: "Ошибка удаления ранга."
        });
    } finally {
        client.release();
    }
});

app.post("/api/admin/users/:id/rank", admin, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const userId = integer(req.params.id, 0);
        const rankIdText = clean(req.body.rankId);

        const userResult = await client.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
            `,
            [userId]
        );

        if (!userResult.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        const rankResult = await client.query(
            `
            SELECT *
            FROM ranks
            WHERE rank_id = $1
            LIMIT 1
            `,
            [rankIdText]
        );

        if (!rankResult.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        const rank = rankResult.rows[0];

        await client.query(
            `
            UPDATE users
            SET
                rank_id = $1,
                owned_ranks = ARRAY(
                    SELECT DISTINCT x
                    FROM unnest(
                        COALESCE(owned_ranks, ARRAY[]::BIGINT[])
                        || ARRAY[$1::BIGINT]
                    ) AS x
                )
            WHERE id = $2
            `,
            [
                rank.id,
                userId
            ]
        );

        await client.query("COMMIT");

        const updated = await getUserById(userId);

        io.emit("leaderboard:update");
        io.emit("ranks:update");

        res.json({
            success: true,
            user: publicUser(updated)
        });
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("ADMIN GIVE RANK ERROR:", error);

        res.status(500).json({
            error: "Ошибка выдачи ранга."
        });
    } finally {
        client.release();
    }
});

app.get("/api/admin/quests", admin, async (req, res) => {
    try {
        const result = await query(`
            SELECT *
            FROM quests
            ORDER BY id DESC
        `);

        res.json({
            success: true,
            quests: result.rows.map(publicQuest)
        });
    } catch (error) {
        console.error("ADMIN QUESTS ERROR:", error);

        res.status(500).json({
            error: "Ошибка загрузки квестов."
        });
    }
});

app.post("/api/admin/quests", admin, async (req, res) => {
    try {
        const questId = clean(req.body.questId);
        const title = clean(req.body.title);
        const description = clean(req.body.description);
        const reward = Math.max(0, integer(req.body.reward, 0));
        const xp = Math.max(0, integer(req.body.xp, 0));

        if (!questId || !title) {
            return res.status(400).json({
                error: "ID и название квеста обязательны."
            });
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(questId)) {
            return res.status(400).json({
                error: "ID квеста может содержать только буквы, цифры, _ и -."
            });
        }

        const result = await query(
            `
            INSERT INTO quests
                (
                    quest_id,
                    title,
                    description,
                    reward,
                    xp,
                    active
                )
            VALUES
                ($1, $2, $3, $4, $5, TRUE)
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

        res.status(201).json({
            success: true,
            quest: publicQuest(result.rows[0])
        });
    } catch (error) {
        console.error("ADMIN CREATE QUEST ERROR:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Квест с таким ID уже существует."
            });
        }

        res.status(500).json({
            error: "Ошибка создания квеста."
        });
    }
});

app.delete("/api/admin/quests/:id", admin, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const id = integer(req.params.id, 0);

        const result = await client.query(
            `
            SELECT id
            FROM quests
            WHERE id = $1
            LIMIT 1
            `,
            [id]
        );

        if (!result.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Квест не найден."
            });
        }

        await client.query(
            `
            DELETE FROM quest_claims
            WHERE quest_id = $1
            `,
            [id]
        );

        await client.query(
            `
            DELETE FROM quests
            WHERE id = $1
            `,
            [id]
        );

        await client.query("COMMIT");

        io.emit("quests:update");

        res.json({
            success: true
        });
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("ADMIN DELETE QUEST ERROR:", error);

        res.status(500).json({
            error: "Ошибка удаления квеста."
        });
    } finally {
        client.release();
    }
});

app.get("/api/admin/status", admin, async (req, res) => {
    try {
        const users = await query(`
            SELECT COUNT(*)::INTEGER AS count
            FROM users
        `);

        const ranks = await query(`
            SELECT COUNT(*)::INTEGER AS count
            FROM ranks
        `);

        const quests = await query(`
            SELECT COUNT(*)::INTEGER AS count
            FROM quests
        `);

        res.json({
            success: true,
            admin: true,
            statistics: {
                users: users.rows[0].count,
                ranks: ranks.rows[0].count,
                quests: quests.rows[0].count
            }
        });
    } catch (error) {
        console.error("ADMIN STATUS ERROR:", error);

        res.status(500).json({
            error: "Ошибка статистики."
        });
    }
});

io.on("connection", socket => {
    console.log("ASTRO: клиент подключился:", socket.id);

    socket.on("disconnect", () => {
        console.log("ASTRO: клиент отключился:", socket.id);
    });
});

app.use((req, res, next) => {
    if (
        req.path.startsWith("/api/") ||
        req.path.startsWith("/socket.io/")
    ) {
        return next();
    }

    next();
});

const publicPath = path.join(__dirname, "public");

app.use(express.static(publicPath));

app.get("*", (req, res, next) => {
    if (
        req.path.startsWith("/api/") ||
        req.path.startsWith("/socket.io/")
    ) {
        return next();
    }

    res.sendFile(path.join(publicPath, "index.html"));
});

app.use((err, req, res, next) => {
    console.error("EXPRESS ERROR:", err);

    res.status(500).json({
        error: "Внутренняя ошибка сервера."
    });
});

async function start() {
    try {
        await initDatabase();

        server.listen(PORT, "0.0.0.0", () => {
            console.log("====================================");
            console.log("ASTRO ONLINE SERVER");
            console.log("PORT:", PORT);
            console.log("DATABASE: PostgreSQL");
            console.log("STATUS: ONLINE");
            console.log("====================================");
        });
    } catch (error) {
        console.error("====================================");
        console.error("FATAL SERVER ERROR:");
        console.error(error);
        console.error("====================================");

        process.exit(1);
    }
}

process.on("unhandledRejection", error => {
    console.error("UNHANDLED REJECTION:", error);
});

process.on("uncaughtException", error => {
    console.error("UNCAUGHT EXCEPTION:", error);
});

process.on("SIGTERM", async () => {
    console.log("ASTRO: SIGTERM");

    try {
        await pool.end();
    } catch (_) {}

    process.exit(0);
});

start();
