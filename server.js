```js
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

const PORT = Number(process.env.PORT) || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });

    pool.on('error', (err) => {
        console.error('POSTGRES POOL ERROR:', err);
    });
}

/* =========================================================
   RANKS
========================================================= */

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

/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {
    if (!pool) {
        console.log('================================');
        console.log('ASTRO ONLINE');
        console.log('DATABASE_URL НЕ ЗАДАН');
        console.log('Сервер запустится, но БД недоступна.');
        console.log('================================');
        return;
    }

    console.log('ASTRO: подключение к PostgreSQL...');

    const client = await pool.connect();

    try {
        /*
         * ВАЖНО:
         *
         * Используются НОВЫЕ таблицы.
         *
         * Мы НЕ используем:
         * ranks
         * user_ranks
         * quest_claims
         * astro_users
         * astro_sessions
         *
         * Старые таблицы вообще не трогаются.
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS astro_v2_users (
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
            CREATE TABLE IF NOT EXISTS astro_v2_sessions (
                token TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS astro_v2_sessions_user_idx
            ON astro_v2_sessions(user_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS astro_v2_rating_idx
            ON astro_v2_users(rating DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS astro_v2_username_idx
            ON astro_v2_users(username)
        `);

        console.log('ASTRO: PostgreSQL подключен.');
        console.log('ASTRO: V2 таблицы готовы.');
        console.log('ASTRO: старые таблицы не используются.');
    } finally {
        client.release();
    }
}

/* =========================================================
   HELPERS
========================================================= */

function hashPassword(password) {
    return crypto
        .createHash('sha256')
        .update(String(password))
        .digest('hex');
}

function createToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getRank(rankId) {
    return (
        RANKS.find((rank) => rank.id === Number(rankId)) ||
        RANKS[0]
    );
}

function publicUser(user) {
    const rank = getRank(user.rank_id);

    return {
        id: Number(user.id),
        username: user.username,
        money: Number(user.money || 0),
        rating: Number(user.rating || 0),
        rank_id: rank.id,
        rank: rank.name,
        rank_color: rank.color
    };
}

function getTokenFromRequest(req) {
    const authorization = String(
        req.headers.authorization || ''
    );

    if (authorization.startsWith('Bearer ')) {
        return authorization
            .slice(7)
            .trim();
    }

    return String(
        req.headers['x-session-token'] || ''
    ).trim();
}

/* =========================================================
   AUTH
========================================================= */

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
        FROM astro_v2_sessions s
        INNER JOIN astro_v2_users u
            ON u.id = s.user_id
        WHERE s.token = $1
        LIMIT 1
    `, [token]);

    return result.rows[0] || null;
}

async function auth(req, res, next) {
    try {
        if (!pool) {
            return res.status(503).json({
                ok: false,
                error: 'База данных не подключена'
            });
        }

        const token = getTokenFromRequest(req);

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

/* =========================================================
   HEALTH
========================================================= */

app.get('/health', async (req, res) => {
    let database = false;

    if (pool) {
        try {
            await pool.query('SELECT 1');
            database = true;
        } catch (error) {
            console.error('HEALTH DB ERROR:', error.message);
        }
    }

    res.json({
        ok: true,
        server: 'ASTRO ONLINE V2',
        database,
        time: new Date().toISOString()
    });
});

/* =========================================================
   API INFO
========================================================= */

app.get('/api', (req, res) => {
    res.json({
        ok: true,
        name: 'ASTRO ONLINE V2',
        version: '2.0.0',
        endpoints: [
            'POST /api/register',
            'POST /api/login',
            'POST /api/logout',
            'GET /api/profile',
            'GET /api/ranks',
            'POST /api/ranks/buy',
            'GET /api/rating',
            'POST /api/rating/add',
            'GET /api/money'
        ]
    });
});

/* =========================================================
   RANKS
========================================================= */

app.get('/api/ranks', (req, res) => {
    res.json({
        ok: true,
        ranks: RANKS
    });
});

/* =========================================================
   REGISTER
========================================================= */

app.post('/api/register', async (req, res) => {
    if (!pool) {
        return res.status(503).json({
            ok: false,
            error: 'База данных не подключена'
        });
    }

    try {
        const username = String(
            req.body.username || ''
        ).trim();

        const password = String(
            req.body.password || ''
        );

        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_]{3,32}$/.test(
                username
            )
        ) {
            return res.status(400).json({
                ok: false,
                error: 'Логин должен содержать от 3 до 32 символов'
            });
        }

        if (password.length < 4) {
            return res.status(400).json({
                ok: false,
                error: 'Пароль должен быть минимум 4 символа'
            });
        }

        const passwordHash = hashPassword(password);

        const exists = await pool.query(`
            SELECT id
            FROM astro_v2_users
            WHERE username = $1
            LIMIT 1
        `, [username]);

        if (exists.rows.length > 0) {
            return res.status(409).json({
                ok: false,
                error: 'Такой пользователь уже существует'
            });
        }

        const created = await pool.query(`
            INSERT INTO astro_v2_users
                (
                    username,
                    password_hash,
                    money,
                    rating,
                    rank_id
                )
            VALUES
                (
                    $1,
                    $2,
                    1000,
                    0,
                    1
                )
            RETURNING
                id,
                username,
                money,
                rating,
                rank_id
        `, [
            username,
            passwordHash
        ]);

        const user = created.rows[0];

        const token = createToken();

        await pool.query(`
            INSERT INTO astro_v2_sessions
                (
                    token,
                    user_id
                )
            VALUES
                (
                    $1,
                    $2
                )
        `, [
            token,
            user.id
        ]);

        return res.status(201).json({
            ok: true,
            token,
            user: publicUser(user)
        });

    } catch (error) {
        console.error('REGISTER ERROR:', error);

        if (error.code === '23505') {
            return res.status(409).json({
                ok: false,
                error: 'Такой пользователь уже существует'
            });
        }

        return res.status(500).json({
            ok: false,
            error: 'Ошибка регистрации'
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', async (req, res) => {
    if (!pool) {
        return res.status(503).json({
            ok: false,
            error: 'База данных не подключена'
        });
    }

    try {
        const username = String(
            req.body.username || ''
        ).trim();

        const password = String(
            req.body.password || ''
        );

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
            FROM astro_v2_users
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

        const passwordHash = hashPassword(password);

        if (passwordHash !== user.password_hash) {
            return res.status(401).json({
                ok: false,
                error: 'Неверный логин или пароль'
            });
        }

        const token = createToken();

        await pool.query(`
            INSERT INTO astro_v2_sessions
                (
                    token,
                    user_id
                )
            VALUES
                (
                    $1,
                    $2
                )
        `, [
            token,
            user.id
        ]);

        return res.json({
            ok: true,
            token,
            user: publicUser(user)
        });

    } catch (error) {
        console.error('LOGIN ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка входа'
        });
    }
});

/* =========================================================
   LOGOUT
========================================================= */

app.post('/api/logout', auth, async (req, res) => {
    try {
        await pool.query(`
            DELETE FROM astro_v2_sessions
            WHERE token = $1
        `, [req.token]);

        return res.json({
            ok: true
        });

    } catch (error) {
        console.error('LOGOUT ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка выхода'
        });
    }
});

/* =========================================================
   PROFILE
========================================================= */

app.get('/api/profile', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                username,
                money,
                rating,
                rank_id
            FROM astro_v2_users
            WHERE id = $1
            LIMIT 1
        `, [req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        return res.json({
            ok: true,
            user: publicUser(result.rows[0])
        });

    } catch (error) {
        console.error('PROFILE ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка профиля'
        });
    }
});

/* =========================================================
   BUY RANK
========================================================= */

app.post('/api/ranks/buy', auth, async (req, res) => {
    const rankId = Number(req.body.rank_id);

    if (!Number.isInteger(rankId)) {
        return res.status(400).json({
            ok: false,
            error: 'Неверный rank_id'
        });
    }

    const rank = RANKS.find(
        (item) => item.id === rankId
    );

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
            SELECT
                id,
                username,
                money,
                rating,
                rank_id
            FROM astro_v2_users
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

        const updated = await client.query(`
            UPDATE astro_v2_users
            SET
                money = money - $1,
                rank_id = $2
            WHERE id = $3
            RETURNING
                id,
                username,
                money,
                rating,
                rank_id
        `, [
            rank.price,
            rank.id,
            user.id
        ]);

        await client.query('COMMIT');

        return res.json({
            ok: true,
            message: `Ранг "${rank.name}" успешно куплен`,
            user: publicUser(updated.rows[0])
        });

    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        console.error('BUY RANK ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка покупки ранга'
        });
    } finally {
        client.release();
    }
});

/* =========================================================
   RATING
========================================================= */

app.get('/api/rating', async (req, res) => {
    if (!pool) {
        return res.json({
            ok: true,
            players: []
        });
    }

    try {
        const result = await pool.query(`
            SELECT
                id,
                username,
                money,
                rating,
                rank_id
            FROM astro_v2_users
            ORDER BY
                rating DESC,
                id ASC
            LIMIT 100
        `);

        const players = result.rows.map(
            (user, index) => ({
                place: index + 1,
                ...publicUser(user)
            })
        );

        return res.json({
            ok: true,
            players
        });

    } catch (error) {
        console.error('RATING ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка рейтинга'
        });
    }
});

/* =========================================================
   ADD RATING
========================================================= */

app.post('/api/rating/add', auth, async (req, res) => {
    const amount = Number(
        req.body.amount
    );

    if (
        !Number.isFinite(amount) ||
        amount === 0
    ) {
        return res.status(400).json({
            ok: false,
            error: 'Неверное количество рейтинга'
        });
    }

    try {
        const result = await pool.query(`
            UPDATE astro_v2_users
            SET
                rating = rating + $1
            WHERE id = $2
            RETURNING
                id,
                username,
                money,
                rating,
                rank_id
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

        return res.json({
            ok: true,
            user: publicUser(result.rows[0])
        });

    } catch (error) {
        console.error('ADD RATING ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка изменения рейтинга'
        });
    }
});

/* =========================================================
   MONEY
========================================================= */

app.get('/api/money', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT money
            FROM astro_v2_users
            WHERE id = $1
            LIMIT 1
        `, [req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        return res.json({
            ok: true,
            money: Number(result.rows[0].money)
        });

    } catch (error) {
        console.error('MONEY ERROR:', error);

        return res.status(500).json({
            ok: false,
            error: 'Ошибка получения денег'
        });
    }
});

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

/*
 * SPA fallback.
 *
 * Для Express 5 используем обычный middleware,
 * а не app.get('*'), чтобы не получить
 * очередную ошибку маршрута.
 */

app.use((req, res, next) => {
    if (
        req.method === 'GET' &&
        !req.path.startsWith('/api/')
    ) {
        return res.sendFile(
            path.join(
                __dirname,
                'public',
                'index.html'
            )
        );
    }

    next();
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
    res.status(404).json({
        ok: false,
        error: 'Маршрут не найден'
    });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
    console.error('EXPRESS ERROR:', error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        ok: false,
        error: 'Внутренняя ошибка сервера'
    });
});

/* =========================================================
   START
========================================================= */

async function start() {
    try {
        await initDatabase();

        app.listen(
            PORT,
            '0.0.0.0',
            () => {
                console.log('');
                console.log('========================================');
                console.log('        ASTRO ONLINE V2');
                console.log('========================================');
                console.log(
                    `Server started on port ${PORT}`
                );
                console.log(
                    'Database mode: astro_v2'
                );
                console.log(
                    'Old tables are NOT used.'
                );
                console.log('========================================');
                console.log('');
            }
        );

    } catch (error) {
        console.error('');
        console.error('========================================');
        console.error('FATAL SERVER ERROR');
        console.error('========================================');
        console.error(error);
        console.error('========================================');

        process.exit(1);
    }
});

/* =========================================================
   PROCESS ERRORS
========================================================= */

process.on(
    'unhandledRejection',
    (error) => {
        console.error(
            'UNHANDLED REJECTION:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    (error) => {
        console.error(
            'UNCAUGHT EXCEPTION:',
            error
        );
    }
);

start();
```
