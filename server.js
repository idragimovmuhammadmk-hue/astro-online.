require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET =
    process.env.JWT_SECRET ||
    'astro-online-super-secret-change-this';

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL ||
    'admin@astro-online.ru';

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    'astro123456';

if (!DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL is missing.');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
        DATABASE_URL &&
        /localhost|127\.0\.0\.1/.test(DATABASE_URL)
            ? false
            : { rejectUnauthorized: false }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '2mb' }));

app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   DEFAULT RANKS
========================================================= */

const DEFAULT_RANKS = [
    {
        id: 'bronze',
        name: 'BRONZE',
        title: 'Бронзовый',
        price: 5000,
        color: '#cd7f32',
        icon: '◆'
    },
    {
        id: 'silver',
        name: 'SILVER',
        title: 'Серебряный',
        price: 15000,
        color: '#b9c3d0',
        icon: '◇'
    },
    {
        id: 'gold',
        name: 'GOLD',
        title: 'Золотой',
        price: 35000,
        color: '#ffd45a',
        icon: '✦'
    },
    {
        id: 'diamond',
        name: 'DIAMOND',
        title: 'Алмазный',
        price: 75000,
        color: '#6ee7ff',
        icon: '✧'
    },
    {
        id: 'master',
        name: 'MASTER',
        title: 'Мастер',
        price: 150000,
        color: '#c084fc',
        icon: '✹'
    },
    {
        id: 'astro',
        name: 'ASTRO',
        title: 'ASTRO ELITE',
        price: 300000,
        color: '#ff6bd6',
        icon: '★'
    }
];

/* =========================================================
   DEFAULT QUESTS
========================================================= */

const DEFAULT_QUESTS = [
    {
        id: 'daily-login',
        title: 'Войти в систему',
        reward: 50,
        xp: 25,
        description: 'Открой профиль и забери ежедневную награду.'
    },
    {
        id: 'daily-explore',
        title: 'Исследователь',
        reward: 100,
        xp: 50,
        description: 'Посети разделы ASTRO и изучи новый сезон.'
    },
    {
        id: 'daily-elite',
        title: 'Elite Protocol',
        reward: 250,
        xp: 100,
        description: 'Выполни особое задание сезона.'
    }
];

/* =========================================================
   DATABASE
========================================================= */

async function init() {
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL is missing');
    }

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

            owned_ranks JSONB NOT NULL DEFAULT '[]',
            claimed_quests JSONB NOT NULL DEFAULT '{}',
            history JSONB NOT NULL DEFAULT '[]',

            is_admin BOOLEAN NOT NULL DEFAULT FALSE,

            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            title TEXT NOT NULL,
            price BIGINT NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#ffffff',
            icon TEXT NOT NULL DEFAULT '◆',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quests (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            reward BIGINT NOT NULL DEFAULT 0,
            xp BIGINT NOT NULL DEFAULT 0,
            description TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    /* Добавляем поля в старую базу, если их не было */

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
    `);

    /* =====================================================
       DEFAULT RANKS
    ===================================================== */

    for (const rank of DEFAULT_RANKS) {
        await pool.query(
            `
            INSERT INTO ranks
            (id, name, title, price, color, icon)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO NOTHING
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

    /* =====================================================
       DEFAULT QUESTS
    ===================================================== */

    for (const quest of DEFAULT_QUESTS) {
        await pool.query(
            `
            INSERT INTO quests
            (id, title, reward, xp, description)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO NOTHING
            `,
            [
                quest.id,
                quest.title,
                quest.reward,
                quest.xp,
                quest.description
            ]
        );
    }

    /* =====================================================
       ADMIN
    ===================================================== */

    const adminCheck = await pool.query(
        `
        SELECT id
        FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1
        `,
        [ADMIN_EMAIL]
    );

    if (!adminCheck.rows[0]) {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

        await pool.query(
            `
            INSERT INTO users
            (
                id,
                email,
                username,
                password_hash,
                balance,
                elo,
                is_admin
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                'ASTRO Admin',
                $2,
                999999999,
                999999,
                TRUE
            )
            `,
            [ADMIN_EMAIL, hash]
        );

        console.log('====================================');
        console.log('ASTRO ADMIN CREATED');
        console.log('Email:', ADMIN_EMAIL);
        console.log('Password:', ADMIN_PASSWORD);
        console.log('====================================');
    } else {
        await pool.query(
            `
            UPDATE users
            SET is_admin = TRUE
            WHERE lower(email) = lower($1)
            `,
            [ADMIN_EMAIL]
        );
    }

    console.log('ASTRO database ready');
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

        isAdmin: Boolean(u.is_admin),

        createdAt: u.created_at,
        lastLoginAt: u.last_login_at
    };
}

function tokenFor(user) {
    return jwt.sign(
        {
            id: user.id,
            isAdmin: Boolean(user.is_admin)
        },
        JWT_SECRET,
        {
            expiresIn: '30d'
        }
    );
}

function cleanId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50);
}

function broadcast() {
    io.emit('leaderboard:update');
    io.emit('astro:update');
}

/* =========================================================
   AUTH
========================================================= */

async function auth(req, res, next) {
    try {
        const header = req.headers.authorization || '';

        const token = header.startsWith('Bearer ')
            ? header.slice(7)
            : '';

        if (!token) {
            return res.status(401).json({
                error: 'Требуется вход.'
            });
        }

        const payload = jwt.verify(token, JWT_SECRET);

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            `,
            [payload.id]
        );

        if (!result.rows[0]) {
            throw new Error('User not found');
        }

        req.user = result.rows[0];

        next();
    } catch (error) {
        return res.status(401).json({
            error: 'Сессия недействительна.'
        });
    }
}

async function adminAuth(req, res, next) {
    await auth(req, res, () => {
        if (!req.user.is_admin) {
            return res.status(403).json({
                error: 'Доступ только для администратора.'
            });
        }

        next();
    });
}

/* =========================================================
   BASIC
========================================================= */

app.get('/api/status', async (req, res) => {
    res.json({
        online: true,
        name: 'ASTRO ONLINE',
        time: new Date().toISOString()
    });
});

/* =========================================================
   ME
========================================================= */

app.get('/api/me', auth, async (req, res) => {
    res.json({
        user: publicUser(req.user)
    });
});

/* =========================================================
   REGISTER
========================================================= */

app.post('/api/register', async (req, res) => {
    try {
        const {
            username,
            email,
            password
        } = req.body || {};

        const e = String(email || '')
            .trim()
            .toLowerCase();

        const n = String(username || '').trim();

        const p = String(password || '');

        if (!/^\S+@\S+\.\S+$/.test(e)) {
            return res.status(400).json({
                error: 'Введите корректный email.'
            });
        }

        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(n)
        ) {
            return res.status(400).json({
                error: 'Никнейм: 3–20 символов.'
            });
        }

        if (p.length < 8) {
            return res.status(400).json({
                error: 'Пароль должен содержать минимум 8 символов.'
            });
        }

        const exists = await pool.query(
            `
            SELECT id
            FROM users
            WHERE lower(email) = lower($1)
               OR lower(username) = lower($2)
            LIMIT 1
            `,
            [e, n]
        );

        if (exists.rows[0]) {
            return res.status(409).json({
                error: 'Email или никнейм уже занят.'
            });
        }

        const hash = await bcrypt.hash(p, 12);

        const result = await pool.query(
            `
            INSERT INTO users
            (
                id,
                email,
                username,
                password_hash
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                $3
            )
            RETURNING *
            `,
            [e, n, hash]
        );

        const user = result.rows[0];

        broadcast();

        res.json({
            token: tokenFor(user),
            user: publicUser(user)
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: 'Не удалось создать аккаунт.'
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', async (req, res) => {
    try {
        const {
            email,
            password
        } = req.body || {};

        const e = String(email || '')
            .trim()
            .toLowerCase();

        const p = String(password || '');

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE lower(email) = lower($1)
            LIMIT 1
            `,
            [e]
        );

        const user = result.rows[0];

        if (
            !user ||
            !(await bcrypt.compare(
                p,
                user.password_hash
            ))
        ) {
            return res.status(401).json({
                error: 'Неверный email или пароль.'
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

        const fresh = (
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
            error: 'Ошибка входа.'
        });
    }
});

/* =========================================================
   PROFILE
========================================================= */

app.put('/api/profile', auth, async (req, res) => {
    try {
        const username = String(
            req.body?.username || ''
        ).trim();

        if (
            !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                username
            )
        ) {
            return res.status(400).json({
                error: 'Никнейм: 3–20 символов.'
            });
        }

        const duplicate = await pool.query(
            `
            SELECT id
            FROM users
            WHERE lower(username) = lower($1)
              AND id <> $2
            LIMIT 1
            `,
            [
                username,
                req.user.id
            ]
        );

        if (duplicate.rows[0]) {
            return res.status(409).json({
                error: 'Такой никнейм уже занят.'
            });
        }

        const result = await pool.query(
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
            user: publicUser(result.rows[0])
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: 'Не удалось сохранить профиль.'
        });
    }
});

/* =========================================================
   RANKS - PUBLIC
========================================================= */

app.get('/api/ranks', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *
            FROM ranks
            ORDER BY price ASC, created_at ASC
            `
        );

        res.json({
            ranks: result.rows.map(r => ({
                id: r.id,
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
            error: 'Ошибка загрузки рангов.'
        });
    }
});

/* =========================================================
   BUY RANK
========================================================= */

app.post('/api/ranks/:id/buy', auth, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const rankResult = await client.query(
            `
            SELECT *
            FROM ranks
            WHERE id = $1
            `,
            [req.params.id]
        );

        const rank = rankResult.rows[0];

        if (!rank) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Ранг не найден.'
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

        const owned = Array.isArray(user.owned_ranks)
            ? [...user.owned_ranks]
            : [];

        if (owned.includes(rank.id)) {
            throw new Error(
                'Этот ранг уже куплен.'
            );
        }

        const price = Number(rank.price);
        const balance = Number(user.balance);

        if (balance < price) {
            throw new Error(
                `Не хватает ${(price - balance).toLocaleString(
                    'ru-RU'
                )} ₽`
            );
        }

        owned.push(rank.id);

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
        ].slice(-30);

        const updated = await client.query(
            `
            UPDATE users
            SET
                balance = balance - $1,
                owned_ranks = $2::jsonb,
                history = $3::jsonb
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

        await client.query('COMMIT');

        broadcast();

        res.json({
            user: publicUser(
                updated.rows[0]
            ),
            rank: {
                id: rank.id,
                name: rank.name,
                title: rank.title,
                price,
                color: rank.color,
                icon: rank.icon
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');

        res.status(400).json({
            error: error.message
        });
    } finally {
        client.release();
    }
});

/* =========================================================
   QUESTS - PUBLIC
========================================================= */

app.get('/api/quests', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *
            FROM quests
            ORDER BY created_at ASC
            `
        );

        res.json({
            quests: result.rows.map(q => ({
                id: q.id,
                title: q.title,
                reward: Number(q.reward),
                xp: Number(q.xp),
                description: q.description,
                createdAt: q.created_at
            }))
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: 'Ошибка загрузки квестов.'
        });
    }
});

/* =========================================================
   CLAIM QUEST
========================================================= */

app.post(
    '/api/quests/:id/claim',
    auth,
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const questResult =
                await client.query(
                    `
                    SELECT *
                    FROM quests
                    WHERE id = $1
                    `,
                    [req.params.id]
                );

            const quest = questResult.rows[0];

            if (!quest) {
                throw new Error(
                    'Квест не найден.'
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

            const user = userResult.rows[0];

            const claimed =
                user.claimed_quests &&
                typeof user.claimed_quests ===
                    'object'
                    ? {
                          ...user.claimed_quests
                      }
                    : {};

            if (claimed[quest.id]) {
                throw new Error(
                    'Этот квест уже получен.'
                );
            }

            claimed[quest.id] = true;

            const reward = Number(
                quest.reward
            );

            const xp = Number(quest.xp);

            const history = [
                ...(Array.isArray(
                    user.history
                )
                    ? user.history
                    : []),
                {
                    title:
                        `Квест · ${quest.title}`,
                    amount: reward,
                    createdAt:
                        new Date().toISOString()
                }
            ].slice(-30);

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance = balance + $1,
                        xp = xp + $2,
                        claimed_quests = $3::jsonb,
                        history = $4::jsonb
                    WHERE id = $5
                    RETURNING *
                    `,
                    [
                        reward,
                        xp,
                        JSON.stringify(
                            claimed
                        ),
                        JSON.stringify(
                            history
                        ),
                        user.id
                    ]
                );

            await client.query(
                'COMMIT'
            );

            broadcast();

            res.json({
                user: publicUser(
                    updated.rows[0]
                ),
                reward,
                xp
            });
        } catch (error) {
            await client.query(
                'ROLLBACK'
            );

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
    '/api/leaderboard',
    async (req, res) => {
        try {
            const players =
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
                        wins DESC
                    `
                );

            const ranks =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    ORDER BY
                        price ASC,
                        created_at ASC
                    `
                );

            const quests =
                await pool.query(
                    `
                    SELECT *
                    FROM quests
                    ORDER BY created_at ASC
                    `
                );

            res.json({
                players:
                    players.rows.map(
                        user => ({
                            id: user.id,
                            username:
                                user.username,
                            elo: Number(
                                user.elo
                            ),
                            xp: Number(
                                user.xp
                            ),
                            wins: Number(
                                user.wins
                            ),
                            ownedRanks:
                                user.owned_ranks ||
                                []
                        })
                    ),

                ranks:
                    ranks.rows.map(
                        rank => ({
                            id: rank.id,
                            name:
                                rank.name,
                            title:
                                rank.title,
                            price:
                                Number(
                                    rank.price
                                ),
                            color:
                                rank.color,
                            icon:
                                rank.icon
                        })
                    ),

                quests:
                    quests.rows.map(
                        quest => ({
                            id:
                                quest.id,
                            title:
                                quest.title,
                            reward:
                                Number(
                                    quest.reward
                                ),
                            xp:
                                Number(
                                    quest.xp
                                ),
                            description:
                                quest.description
                        })
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Ошибка рейтинга.'
            });
        }
    }
);

/* =========================================================
   ADMIN - INFO
========================================================= */

app.get(
    '/api/admin/me',
    adminAuth,
    async (req, res) => {
        res.json({
            admin: true,
            user: publicUser(
                req.user
            )
        });
    }
);

/* =========================================================
   ADMIN - DASHBOARD
========================================================= */

app.get(
    '/api/admin/dashboard',
    adminAuth,
    async (req, res) => {
        try {
            const users =
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
                        is_admin,
                        created_at
                    FROM users
                    ORDER BY elo DESC
                    `
                );

            const ranks =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    ORDER BY created_at ASC
                    `
                );

            const quests =
                await pool.query(
                    `
                    SELECT *
                    FROM quests
                    ORDER BY created_at ASC
                    `
                );

            res.json({
                users:
                    users.rows.map(
                        u => ({
                            id: u.id,
                            email:
                                u.email,
                            username:
                                u.username,
                            balance:
                                Number(
                                    u.balance
                                ),
                            xp:
                                Number(
                                    u.xp
                                ),
                            elo:
                                Number(
                                    u.elo
                                ),
                            wins:
                                Number(
                                    u.wins
                                ),
                            ownedRanks:
                                u.owned_ranks ||
                                [],
                            isAdmin:
                                Boolean(
                                    u.is_admin
                                ),
                            createdAt:
                                u.created_at
                        })
                    ),

                ranks:
                    ranks.rows.map(
                        r => ({
                            id:
                                r.id,
                            name:
                                r.name,
                            title:
                                r.title,
                            price:
                                Number(
                                    r.price
                                ),
                            color:
                                r.color,
                            icon:
                                r.icon,
                            createdAt:
                                r.created_at
                        })
                    ),

                quests:
                    quests.rows.map(
                        q => ({
                            id:
                                q.id,
                            title:
                                q.title,
                            reward:
                                Number(
                                    q.reward
                                ),
                            xp:
                                Number(
                                    q.xp
                                ),
                            description:
                                q.description,
                            createdAt:
                                q.created_at
                        })
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Ошибка админ-панели.'
            });
        }
    }
);

/* =========================================================
   ADMIN - USERS
========================================================= */

app.get(
    '/api/admin/users',
    adminAuth,
    async (req, res) => {
        try {
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
                        is_admin,
                        created_at
                    FROM users
                    ORDER BY
                        elo DESC,
                        xp DESC
                    `
                );

            res.json({
                users:
                    result.rows.map(
                        u => ({
                            id: u.id,
                            email:
                                u.email,
                            username:
                                u.username,
                            balance:
                                Number(
                                    u.balance
                                ),
                            xp:
                                Number(
                                    u.xp
                                ),
                            elo:
                                Number(
                                    u.elo
                                ),
                            wins:
                                Number(
                                    u.wins
                                ),
                            ownedRanks:
                                u.owned_ranks ||
                                [],
                            isAdmin:
                                Boolean(
                                    u.is_admin
                                ),
                            createdAt:
                                u.created_at
                        })
                    )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось загрузить пользователей.'
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE BALANCE
========================================================= */

app.post(
    '/api/admin/users/:id/balance',
    adminAuth,
    async (req, res) => {
        try {
            const amount = Number(
                req.body?.amount
            );

            if (
                !Number.isFinite(
                    amount
                )
            ) {
                return res.status(400).json({
                    error:
                        'Некорректная сумма.'
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET balance =
                        GREATEST(
                            0,
                            balance + $1
                        )
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        Math.trunc(amount),
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось изменить баланс.'
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE ELO
========================================================= */

app.post(
    '/api/admin/users/:id/elo',
    adminAuth,
    async (req, res) => {
        try {
            const amount = Number(
                req.body?.amount
            );

            if (
                !Number.isFinite(
                    amount
                )
            ) {
                return res.status(400).json({
                    error:
                        'Некорректное количество ELO.'
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET elo =
                        GREATEST(
                            0,
                            elo + $1
                        )
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        Math.trunc(amount),
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось изменить ELO.'
            });
        }
    }
);

/* =========================================================
   ADMIN - SET ELO
========================================================= */

app.put(
    '/api/admin/users/:id/elo',
    adminAuth,
    async (req, res) => {
        try {
            const elo = Number(
                req.body?.elo
            );

            if (
                !Number.isFinite(
                    elo
                ) ||
                elo < 0
            ) {
                return res.status(400).json({
                    error:
                        'Некорректный ELO.'
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET elo = $1
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        Math.trunc(elo),
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось установить ELO.'
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE WINS
========================================================= */

app.post(
    '/api/admin/users/:id/wins',
    adminAuth,
    async (req, res) => {
        try {
            const amount = Number(
                req.body?.amount
            );

            if (
                !Number.isFinite(
                    amount
                )
            ) {
                return res.status(400).json({
                    error:
                        'Некорректное количество побед.'
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET wins =
                        GREATEST(
                            0,
                            wins + $1
                        )
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        Math.trunc(amount),
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось изменить победы.'
            });
        }
    }
);

/* =========================================================
   ADMIN - SET WINS
========================================================= */

app.put(
    '/api/admin/users/:id/wins',
    adminAuth,
    async (req, res) => {
        try {
            const wins = Number(
                req.body?.wins
            );

            if (
                !Number.isFinite(
                    wins
                ) ||
                wins < 0
            ) {
                return res.status(400).json({
                    error:
                        'Некорректное количество побед.'
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE users
                    SET wins = $1
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        Math.trunc(wins),
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось установить победы.'
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE RANK
========================================================= */

app.post(
    '/api/admin/users/:id/ranks/:rankId',
    adminAuth,
    async (req, res) => {
        try {
            const rankResult =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE id = $1
                    `,
                    [req.params.rankId]
                );

            const rank =
                rankResult.rows[0];

            if (!rank) {
                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

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
                        'Пользователь не найден.'
                });
            }

            const ranks =
                Array.isArray(
                    user.owned_ranks
                )
                    ? [
                          ...user.owned_ranks
                      ]
                    : [];

            if (!ranks.includes(rank.id)) {
                ranks.push(rank.id);
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
                        JSON.stringify(
                            ranks
                        ),
                        user.id
                    ]
                );

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                ),
                rank
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось выдать ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - REMOVE RANK
========================================================= */

app.delete(
    '/api/admin/users/:id/ranks/:rankId',
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
                        'Пользователь не найден.'
                });
            }

            const ranks =
                Array.isArray(
                    user.owned_ranks
                )
                    ? user.owned_ranks.filter(
                          id =>
                              id !==
                              req.params
                                  .rankId
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
                        JSON.stringify(
                            ranks
                        ),
                        user.id
                    ]
                );

            broadcast();

            res.json({
                user: publicUser(
                    result.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось снять ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - CREATE RANK
========================================================= */

app.post(
    '/api/admin/ranks',
    adminAuth,
    async (req, res) => {
        try {
            const id = cleanId(
                req.body?.id ||
                    req.body?.name
            );

            const name = String(
                req.body?.name || ''
            ).trim();

            const title = String(
                req.body?.title ||
                    name
            ).trim();

            const price = Number(
                req.body?.price || 0
            );

            const color = String(
                req.body?.color ||
                    '#ffffff'
            ).trim();

            const icon = String(
                req.body?.icon ||
                    '◆'
            ).trim();

            if (!id) {
                return res.status(400).json({
                    error:
                        'Укажи ID ранга.'
                });
            }

            if (!name) {
                return res.status(400).json({
                    error:
                        'Укажи название ранга.'
                });
            }

            if (
                !Number.isFinite(
                    price
                ) ||
                price < 0
            ) {
                return res.status(400).json({
                    error:
                        'Некорректная цена.'
                });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM ranks
                    WHERE id = $1
                    `,
                    [id]
                );

            if (exists.rows[0]) {
                return res.status(409).json({
                    error:
                        'Ранг с таким ID уже существует.'
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
                    (
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
                        id,
                        name,
                        title,
                        Math.trunc(
                            price
                        ),
                        color,
                        icon
                    ]
                );

            broadcast();

            res.json({
                rank: {
                    id:
                        result.rows[0]
                            .id,
                    name:
                        result.rows[0]
                            .name,
                    title:
                        result.rows[0]
                            .title,
                    price:
                        Number(
                            result.rows[0]
                                .price
                        ),
                    color:
                        result.rows[0]
                            .color,
                    icon:
                        result.rows[0]
                            .icon
                }
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось создать ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - DELETE RANK
========================================================= */

app.delete(
    '/api/admin/ranks/:id',
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    DELETE FROM ranks
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

            /* Убираем этот ранг у всех игроков */

            const users =
                await pool.query(
                    `
                    SELECT id, owned_ranks
                    FROM users
                    `
                );

            for (const user of users.rows) {
                const ranks =
                    Array.isArray(
                        user.owned_ranks
                    )
                        ? user.owned_ranks.filter(
                              id =>
                                  id !==
                                  req.params.id
                          )
                        : [];

                await pool.query(
                    `
                    UPDATE users
                    SET owned_ranks = $1::jsonb
                    WHERE id = $2
                    `,
                    [
                        JSON.stringify(
                            ranks
                        ),
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
                    'Не удалось удалить ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - UPDATE RANK
========================================================= */

app.put(
    '/api/admin/ranks/:id',
    adminAuth,
    async (req, res) => {
        try {
            const name =
                req.body?.name !== undefined
                    ? String(
                          req.body.name
                      ).trim()
                    : null;

            const title =
                req.body?.title !==
                undefined
                    ? String(
                          req.body.title
                      ).trim()
                    : null;

            const price =
                req.body?.price !==
                undefined
                    ? Number(
                          req.body.price
                      )
                    : null;

            const color =
                req.body?.color !==
                undefined
                    ? String(
                          req.body.color
                      ).trim()
                    : null;

            const icon =
                req.body?.icon !==
                undefined
                    ? String(
                          req.body.icon
                      ).trim()
                    : null;

            const result =
                await pool.query(
                    `
                    UPDATE ranks
                    SET
                        name =
                            COALESCE(
                                $1,
                                name
                            ),
                        title =
                            COALESCE(
                                $2,
                                title
                            ),
                        price =
                            COALESCE(
                                $3,
                                price
                            ),
                        color =
                            COALESCE(
                                $4,
                                color
                            ),
                        icon =
                            COALESCE(
                                $5,
                                icon
                            )
                    WHERE id = $6
                    RETURNING *
                    `,
                    [
                        name,
                        title,
                        price === null
                            ? null
                            : Math.trunc(
                                  price
                              ),
                        color,
                        icon,
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

            broadcast();

            res.json({
                rank:
                    result.rows[0]
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось изменить ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - CREATE QUEST
========================================================= */

app.post(
    '/api/admin/quests',
    adminAuth,
    async (req, res) => {
        try {
            const id = cleanId(
                req.body?.id ||
                    req.body?.title
            );

            const title = String(
                req.body?.title || ''
            ).trim();

            const reward = Number(
                req.body?.reward || 0
            );

            const xp = Number(
                req.body?.xp || 0
            );

            const description =
                String(
                    req.body?.description ||
                        ''
                ).trim();

            if (!id) {
                return res.status(400).json({
                    error:
                        'Укажи ID квеста.'
                });
            }

            if (!title) {
                return res.status(400).json({
                    error:
                        'Укажи название квеста.'
                });
            }

            if (
                !Number.isFinite(
                    reward
                ) ||
                reward < 0
            ) {
                return res.status(400).json({
                    error:
                        'Некорректная награда.'
                });
            }

            if (
                !Number.isFinite(
                    xp
                ) ||
                xp < 0
            ) {
                return res.status(400).json({
                    error:
                        'Некорректный XP.'
                });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM quests
                    WHERE id = $1
                    `,
                    [id]
                );

            if (exists.rows[0]) {
                return res.status(409).json({
                    error:
                        'Квест с таким ID уже существует.'
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO quests
                    (
                        id,
                        title,
                        reward,
                        xp,
                        description
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5
                    )
                    RETURNING *
                    `,
                    [
                        id,
                        title,
                        Math.trunc(
                            reward
                        ),
                        Math.trunc(xp),
                        description
                    ]
                );

            broadcast();

            res.json({
                quest: {
                    id:
                        result.rows[0]
                            .id,
                    title:
                        result.rows[0]
                            .title,
                    reward:
                        Number(
                            result.rows[0]
                                .reward
                        ),
                    xp:
                        Number(
                            result.rows[0]
                                .xp
                        ),
                    description:
                        result.rows[0]
                            .description
                }
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось создать квест.'
            });
        }
    }
);

/* =========================================================
   ADMIN - DELETE QUEST
========================================================= */

app.delete(
    '/api/admin/quests/:id',
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    DELETE FROM quests
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            /* Убираем отметку о выполнении
               удалённого квеста у игроков */

            const users =
                await pool.query(
                    `
                    SELECT
                        id,
                        claimed_quests
                    FROM users
                    `
                );

            for (const user of users.rows) {
                const claimed =
                    user.claimed_quests &&
                    typeof user.claimed_quests ===
                        'object'
                        ? {
                              ...user.claimed_quests
                          }
                        : {};

                delete claimed[
                    req.params.id
                ];

                await pool.query(
                    `
                    UPDATE users
                    SET claimed_quests =
                        $1::jsonb
                    WHERE id = $2
                    `,
                    [
                        JSON.stringify(
                            claimed
                        ),
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
                    'Не удалось удалить квест.'
            });
        }
    }
);

/* =========================================================
   ADMIN - UPDATE QUEST
========================================================= */

app.put(
    '/api/admin/quests/:id',
    adminAuth,
    async (req, res) => {
        try {
            const title =
                req.body?.title !==
                undefined
                    ? String(
                          req.body.title
                      ).trim()
                    : null;

            const reward =
                req.body?.reward !==
                undefined
                    ? Number(
                          req.body.reward
                      )
                    : null;

            const xp =
                req.body?.xp !==
                undefined
                    ? Number(
                          req.body.xp
                      )
                    : null;

            const description =
                req.body?.description !==
                undefined
                    ? String(
                          req.body
                              .description
                      ).trim()
                    : null;

            const result =
                await pool.query(
                    `
                    UPDATE quests
                    SET
                        title =
                            COALESCE(
                                $1,
                                title
                            ),
                        reward =
                            COALESCE(
                                $2,
                                reward
                            ),
                        xp =
                            COALESCE(
                                $3,
                                xp
                            ),
                        description =
                            COALESCE(
                                $4,
                                description
                            )
                    WHERE id = $5
                    RETURNING *
                    `,
                    [
                        title,
                        reward === null
                            ? null
                            : Math.trunc(
                                  reward
                              ),
                        xp === null
                            ? null
                            : Math.trunc(
                                  xp
                              ),
                        description,
                        req.params.id
                    ]
                );

            if (!result.rows[0]) {
                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            broadcast();

            res.json({
                quest:
                    result.rows[0]
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось изменить квест.'
            });
        }
    }
);

/* =========================================================
   ADMIN - RESET CLAIMED QUEST
========================================================= */

app.delete(
    '/api/admin/users/:id/quests/:questId/claim',
    adminAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        claimed_quests
                    FROM users
                    WHERE id = $1
                    `,
                    [req.params.id]
                );

            const user =
                result.rows[0];

            if (!user) {
                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            const claimed =
                user.claimed_quests &&
                typeof user.claimed_quests ===
                    'object'
                    ? {
                          ...user.claimed_quests
                      }
                    : {};

            delete claimed[
                req.params.questId
            ];

            const updated =
                await pool.query(
                    `
                    UPDATE users
                    SET claimed_quests =
                        $1::jsonb
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        JSON.stringify(
                            claimed
                        ),
                        user.id
                    ]
                );

            broadcast();

            res.json({
                user: publicUser(
                    updated.rows[0]
                )
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    'Не удалось сбросить квест.'
            });
        }
    }
);

/* =========================================================
   SOCKET.IO
========================================================= */

io.on('connection', socket => {
    console.log(
        'ASTRO socket connected:',
        socket.id
    );

    socket.on(
        'disconnect',
        () => {
            console.log(
                'ASTRO socket disconnected:',
                socket.id
            );
        }
    );
});

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.get('*', (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            'public',
            'index.html'
        )
    );
});

/* =========================================================
   START
========================================================= */

init()
    .then(() => {
        server.listen(
            PORT,
            '0.0.0.0',
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
            'ASTRO START ERROR:',
            error
        );

        process.exit(1);
    });
