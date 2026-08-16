```js
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   POSTGRESQL
========================= */

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });
}

/* =========================
   RANKS
========================= */

const RANKS = [
    {
        id: 1,
        name: 'Новичок',
        price: 0,
        color: '#94a3b8'
    },
    {
        id: 2,
        name: 'Кадет',
        price: 500,
        color: '#38bdf8'
    },
    {
        id: 3,
        name: 'Пилот',
        price: 1500,
        color: '#22c55e'
    },
    {
        id: 4,
        name: 'Офицер',
        price: 3000,
        color: '#a78bfa'
    },
    {
        id: 5,
        name: 'Капитан',
        price: 6000,
        color: '#f59e0b'
    },
    {
        id: 6,
        name: 'Адмирал',
        price: 12000,
        color: '#ef4444'
    }
];

/* =========================
   DATABASE
========================= */

async function initDatabase() {
    if (!pool) {
        console.log('ASTRO: DATABASE_URL не задан.');
        console.log('ASTRO: сервер запущен без PostgreSQL.');
        return;
    }

    console.log('ASTRO: подключение к PostgreSQL...');

    const client = await pool.connect();

    try {
        /*
         * ВАЖНО:
         * Никаких FOREIGN KEY.
         * Никаких rank_id -> ranks.id.
         * Никаких user_id -> uuid.
         *
         * user_id в нашей таблице обычный BIGINT.
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS astro_users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(32) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                money BIGINT NOT NULL DEFAULT 1000,
                rating BIGINT NOT NULL DEFAULT 0,
                rank_id INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS astro_sessions (
                token TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS astro_sessions_user_idx
            ON astro_sessions(user_id)
        `);

        console.log('ASTRO: PostgreSQL подключен.');
        console.log('ASTRO: таблицы готовы.');
    } finally {
        client.release();
    }
}

/* =========================
   PASSWORD
========================= */

function hashPassword(password) {
    return crypto
        .createHash('sha256')
        .update(String(password))
        .digest('hex');
}

/* =========================
   TOKEN
========================= */

function createToken() {
    return crypto.randomBytes(32).toString('hex');
}

/* =========================
   USER
========================= */

function publicUser(user) {
    const rank =
        RANKS.find(r => r.id === Number(user.rank_id)) ||
        RANKS[0];

    return {
        id: Number(user.id),
        username: user.username,
        money: Number(user.money || 0),
        rating: Number(user.rating || 0),
        rank: rank.name,
        rank_id: rank.id,
        rank_color: rank.color
    };
}

/* =========================
   AUTH
========================= */

async function getUserByToken(token) {
    if (!pool || !token) {
        return null;
    }

    const result = await pool.query(`
        SELECT
            u.id,
            u.username,
            u.money,
            u.rating,
            u.rank_id
        FROM astro_sessions s
        JOIN astro_users u
            ON u.id = s.user_id
        WHERE s.token = $1
        LIMIT 1
    `, [token]);

    return result.rows[0] || null;
}

async function auth(req, res, next) {
    try {
        const header = req.headers.authorization || '';

        let token = '';

        if (header.startsWith('Bearer ')) {
            token = header.substring(7).trim();
        }

        if (!token) {
            token = String(req.headers['x-session-token'] || '').trim();
        }

        if (!token) {
            return res.status(401).json({
                ok: false,
                error: 'Не авторизован'
            });
        }

        const user = await getUserByToken(token);

        if (!user) {
            return res.status(401).json({
                ok: false,
                error: 'Сессия недействительна'
            });
        }

        req.token = token;
        req.user = user;

        next();
    } catch (error) {
        console.error('AUTH ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка авторизации'
        });
    }
}

/* =========================
   HEALTH
========================= */

app.get('/health', async (req, res) => {
    let database = false;

    if (pool) {
        try {
            await pool.query('SELECT 1');
            database = true;
        } catch (_) {
            database = false;
        }
    }

    res.json({
        ok: true,
        server: 'ASTRO ONLINE',
        database,
        time: new Date().toISOString()
    });
});

/* =========================
   RANKS API
========================= */

app.get('/api/ranks', (req, res) => {
    res.json({
        ok: true,
        ranks: RANKS
    });
});

/* =========================
   REGISTER
========================= */

app.post('/api/register', async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                ok: false,
                error: 'База данных не подключена'
            });
        }

        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({
                ok: false,
                error: 'Логин: от 3 до 32 символов'
            });
        }

        if (password.length < 4) {
            return res.status(400).json({
                ok: false,
                error: 'Пароль должен быть минимум 4 символа'
            });
        }

        const passwordHash = hashPassword(password);

        const exists = await pool.query(
            `SELECT id FROM astro_users WHERE username = $1 LIMIT 1`,
            [username]
        );

        if (exists.rows.length > 0) {
            return res.status(409).json({
                ok: false,
                error: 'Такой пользователь уже существует'
            });
        }

        const created = await pool.query(`
            INSERT INTO astro_users
                (username, password_hash, money, rating, rank_id)
            VALUES
                ($1, $2, 1000, 0, 1)
            RETURNING id, username, money, rating, rank_id
        `, [username, passwordHash]);

        const user = created.rows[0];
        const token = createToken();

        await pool.query(`
            INSERT INTO astro_sessions(token, user_id)
            VALUES($1, $2)
        `, [token, user.id]);

        res.json({
            ok: true,
            token,
            user: publicUser(user)
        });

    } catch (error) {
        console.error('REGISTER ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка регистрации'
        });
    }
});

/* =========================
   LOGIN
========================= */

app.post('/api/login', async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                ok: false,
                error: 'База данных не подключена'
            });
        }

        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        if (!username || !password) {
            return res.status(400).json({
                ok: false,
                error: 'Введите логин и пароль'
            });
        }

        const result = await pool.query(`
            SELECT
                id,
                username,
                password_hash,
                money,
                rating,
                rank_id
            FROM astro_users
            WHERE username = $1
            LIMIT 1
        `, [username]);

        if (result.rows.length === 0) {
            return res.status(401).json({
                ok: false,
                error: 'Неверный логин или пароль'
            });
        }

        const user = result.rows[0];

        if (hashPassword(password) !== user.password_hash) {
            return res.status(401).json({
                ok: false,
                error: 'Неверный логин или пароль'
            });
        }

        const token = createToken();

        await pool.query(`
            INSERT INTO astro_sessions(token, user_id)
            VALUES($1, $2)
        `, [token, user.id]);

        res.json({
            ok: true,
            token,
            user: publicUser(user)
        });

    } catch (error) {
        console.error('LOGIN ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка входа'
        });
    }
});

/* =========================
   LOGOUT
========================= */

app.post('/api/logout', auth, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM astro_sessions WHERE token = $1`,
            [req.token]
        );

        res.json({
            ok: true
        });

    } catch (error) {
        console.error('LOGOUT ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка выхода'
        });
    }
});

/* =========================
   PROFILE
========================= */

app.get('/api/profile', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                username,
                money,
                rating,
                rank_id
            FROM astro_users
            WHERE id = $1
            LIMIT 1
        `, [req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        res.json({
            ok: true,
            user: publicUser(result.rows[0])
        });

    } catch (error) {
        console.error('PROFILE ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка профиля'
        });
    }
});

/* =========================
   BUY RANK
========================= */

app.post('/api/ranks/buy', auth, async (req, res) => {
    const rankId = Number(req.body.rank_id);

    if (!Number.isInteger(rankId)) {
        return res.status(400).json({
            ok: false,
            error: 'Неверный rank_id'
        });
    }

    const rank = RANKS.find(r => r.id === rankId);

    if (!rank) {
        return res.status(404).json({
            ok: false,
            error: 'Ранг не найден'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(`
            SELECT id, username, money, rating, rank_id
            FROM astro_users
            WHERE id = $1
            FOR UPDATE
        `, [req.user.id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        const user = result.rows[0];
        const money = Number(user.money);
        const currentRankId = Number(user.rank_id);

        if (rankId <= currentRankId) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                ok: false,
                error: 'Этот ранг уже куплен или ниже текущего'
            });
        }

        if (money < rank.price) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                ok: false,
                error: 'Недостаточно денег',
                money,
                required: rank.price
            });
        }

        const newMoney = money - rank.price;

        const updated = await client.query(`
            UPDATE astro_users
            SET
                money = $1,
                rank_id = $2
            WHERE id = $3
            RETURNING id, username, money, rating, rank_id
        `, [
            newMoney,
            rankId,
            req.user.id
        ]);

        await client.query('COMMIT');

        res.json({
            ok: true,
            message: `Ранг "${rank.name}" успешно куплен`,
            user: publicUser(updated.rows[0])
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('BUY RANK ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка покупки ранга'
        });
    } finally {
        client.release();
    }
});

/* =========================
   RATING
========================= */

app.get('/api/rating', async (req, res) => {
    try {
        if (!pool) {
            return res.json({
                ok: true,
                players: []
            });
        }

        const result = await pool.query(`
            SELECT
                id,
                username,
                rating,
                money,
                rank_id
            FROM astro_users
            ORDER BY rating DESC, id ASC
            LIMIT 100
        `);

        const players = result.rows.map((user, index) => ({
            place: index + 1,
            ...publicUser(user)
        }));

        res.json({
            ok: true,
            players
        });

    } catch (error) {
        console.error('RATING ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка рейтинга'
        });
    }
});

/* =========================
   ADD RATING
========================= */

app.post('/api/rating/add', auth, async (req, res) => {
    const amount = Number(req.body.amount || 0);

    if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({
            ok: false,
            error: 'Неверное количество рейтинга'
        });
    }

    try {
        const result = await pool.query(`
            UPDATE astro_users
            SET rating = rating + $1
            WHERE id = $2
            RETURNING id, username, money, rating, rank_id
        `, [
            Math.trunc(amount),
            req.user.id
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        res.json({
            ok: true,
            user: publicUser(result.rows[0])
        });

    } catch (error) {
        console.error('ADD RATING ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка изменения рейтинга'
        });
    }
});

/* =========================
   MONEY
========================= */

app.get('/api/money', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT money
            FROM astro_users
            WHERE id = $1
        `, [req.user.id]);

        if (!result.rows.length) {
            return res.status(404).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        res.json({
            ok: true,
            money: Number(result.rows[0].money)
        });

    } catch (error) {
        console.error('MONEY ERROR:', error);

        res.status(500).json({
            ok: false,
            error: 'Ошибка получения денег'
        });
    }
});

/* =========================
   STATIC
========================= */

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(
        path.join(__dirname, 'public', 'index.html')
    );
});

/* =========================
   START
========================= */

async function start() {
    try {
        await initDatabase();

        app.listen(PORT, '0.0.0.0', () => {
            console.log('================================');
            console.log('ASTRO ONLINE');
            console.log(`Server started on port ${PORT}`);
            console.log('================================');
        });

    } catch (error) {
        console.error('FATAL SERVER ERROR:');
        console.error(error);

        /*
         * Не оставляем Render с непонятным зависанием.
         */
        process.exit(1);
    }
}

process.on('unhandledRejection', error => {
    console.error('UNHANDLED REJECTION:', error);
});

process.on('uncaughtException', error => {
    console.error('UNCAUGHT EXCEPTION:', error);
});

start();
```
