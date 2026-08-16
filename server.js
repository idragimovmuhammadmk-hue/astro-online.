```javascript
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'astro-change-this-secret';

const ADMIN_EMAIL =
    (process.env.ADMIN_EMAIL || 'admin@astro.online').toLowerCase();

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || 'AstroAdmin123!';

const ADMIN_USERNAME =
    process.env.ADMIN_USERNAME || 'ASTRO_ADMIN';

if (!DATABASE_URL) {
    console.error('FATAL SERVER ERROR: DATABASE_URL is not set.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

function cleanText(value, max = 200) {
    return String(value ?? '')
        .trim()
        .slice(0, max);
}

function positiveNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeEmail(value) {
    return cleanText(value, 254).toLowerCase();
}

function signUser(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role
        },
        JWT_SECRET,
        {
            expiresIn: '30d'
        }
    );
}

function publicUser(user, rank = null) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,

        balance: Number(user.balance || 0),
        elo: Number(user.elo || 0),
        xp: Number(user.xp || 0),
        wins: Number(user.wins || 0),

        rank: rank
            ? {
                id: rank.id,
                rankId: rank.rank_id,
                name: rank.name,
                title: rank.title,
                price: Number(rank.price || 0),
                color: rank.color,
                icon: rank.icon
            }
            : null
    };
}

async function getUserById(id) {
    const result = await pool.query(
        'SELECT * FROM users WHERE id = $1 LIMIT 1',
        [id]
    );

    return result.rows[0] || null;
}

async function getCurrentRank(userId) {
    const result = await pool.query(`
        SELECT r.*
        FROM user_ranks ur
        JOIN ranks r
            ON r.id = ur.rank_id
        WHERE ur.user_id = $1
          AND ur.is_active = TRUE
        ORDER BY ur.created_at DESC
        LIMIT 1
    `, [userId]);

    return result.rows[0] || null;
}

async function getUserWithRank(id) {
    const user = await getUserById(id);

    if (!user) {
        return null;
    }

    const rank = await getCurrentRank(id);

    return {
        user,
        rank
    };
}

function authRequired(req, res, next) {
    const header =
        req.headers.authorization || '';

    const token =
        header.startsWith('Bearer ')
            ? header.slice(7)
            : null;

    if (!token) {
        return res.status(401).json({
            error: 'Требуется вход в аккаунт.'
        });
    }

    try {
        req.auth = jwt.verify(
            token,
            JWT_SECRET
        );

        next();
    } catch (_) {
        return res.status(401).json({
            error: 'Сессия истекла. Войдите снова.'
        });
    }
}

async function adminRequired(req, res, next) {
    try {
        if (!req.auth) {
            return res.status(401).json({
                error: 'Требуется вход.'
            });
        }

        const user =
            await getUserById(req.auth.id);

        if (!user || user.role !== 'admin') {
            return res.status(403).json({
                error: 'Доступ только для администратора.'
            });
        }

        req.user = user;

        next();

    } catch (error) {
        console.error(
            'ADMIN AUTH ERROR:',
            error
        );

        return res.status(500).json({
            error: 'Ошибка проверки администратора.'
        });
    }
}

async function ensureAdmin() {
    const hash =
        await bcrypt.hash(
            ADMIN_PASSWORD,
            12
        );

    const existing =
        await pool.query(
            'SELECT id FROM users WHERE email = $1 LIMIT 1',
            [ADMIN_EMAIL]
        );

    if (existing.rowCount === 0) {

        await pool.query(`
            INSERT INTO users
            (
                username,
                email,
                password_hash,
                role,
                balance,
                elo,
                xp,
                wins
            )
            VALUES
            (
                $1,
                $2,
                $3,
                'admin',
                1000000,
                3000,
                0,
                0
            )
        `, [
            ADMIN_USERNAME,
            ADMIN_EMAIL,
            hash
        ]);

        console.log(
            'ASTRO: admin account created:',
            ADMIN_EMAIL
        );

    } else {

        await pool.query(`
            UPDATE users
            SET
                role = 'admin',
                password_hash = $1
            WHERE email = $2
        `, [
            hash,
            ADMIN_EMAIL
        ]);

        console.log(
            'ASTRO: admin account ready:',
            ADMIN_EMAIL
        );
    }
}

async function initDatabase() {

    const client =
        await pool.connect();

    try {

        await client.query('BEGIN');

        /*
         * USERS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,

                username VARCHAR(40)
                    NOT NULL UNIQUE,

                email VARCHAR(254)
                    NOT NULL UNIQUE,

                password_hash TEXT
                    NOT NULL,

                role VARCHAR(20)
                    NOT NULL DEFAULT 'user',

                balance BIGINT
                    NOT NULL DEFAULT 0,

                elo INTEGER
                    NOT NULL DEFAULT 1000,

                xp BIGINT
                    NOT NULL DEFAULT 0,

                wins INTEGER
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            )
        `);

        /*
         * RANKS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS ranks (
                id BIGSERIAL PRIMARY KEY,

                rank_id VARCHAR(80)
                    NOT NULL UNIQUE,

                name VARCHAR(80)
                    NOT NULL,

                title VARCHAR(120)
                    NOT NULL DEFAULT '',

                price BIGINT
                    NOT NULL DEFAULT 0,

                color VARCHAR(30)
                    NOT NULL DEFAULT '#9b7cff',

                icon VARCHAR(20)
                    NOT NULL DEFAULT '★',

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            )
        `);

        /*
         * USER RANKS
         *
         * ВАЖНО:
         *
         * ranks.id = BIGINT
         * user_ranks.rank_id = BIGINT
         *
         * Поэтому PostgreSQL больше не получит
         * ошибку incompatible types.
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS user_ranks (
                id BIGSERIAL PRIMARY KEY,

                user_id BIGINT
                    NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,

                rank_id BIGINT
                    NOT NULL
                    REFERENCES ranks(id)
                    ON DELETE CASCADE,

                is_active BOOLEAN
                    NOT NULL DEFAULT TRUE,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                UNIQUE(user_id, rank_id)
            )
        `);

        /*
         * QUESTS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS quests (
                id BIGSERIAL PRIMARY KEY,

                quest_id VARCHAR(80)
                    NOT NULL UNIQUE,

                title VARCHAR(120)
                    NOT NULL,

                description TEXT
                    NOT NULL DEFAULT '',

                reward BIGINT
                    NOT NULL DEFAULT 0,

                xp BIGINT
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            )
        `);

        /*
         * QUEST CLAIMS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS quest_claims (
                id BIGSERIAL PRIMARY KEY,

                user_id BIGINT
                    NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,

                quest_id BIGINT
                    NOT NULL
                    REFERENCES quests(id)
                    ON DELETE CASCADE,

                claimed_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                UNIQUE(user_id, quest_id)
            )
        `);

        /*
         * INDEXES
         */

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            idx_users_elo
            ON users(elo DESC, wins DESC, xp DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            idx_user_ranks_user
            ON user_ranks(user_id, is_active)
        `);

        /*
         * DEFAULT RANKS
         */

        await client.query(`
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
                '◈'
            ),

            (
                'master',
                'MASTER',
                'Мастер',
                150000,
                '#c084fc',
                '✪'
            ),

            (
                'astro',
                'ASTRO',
                'ASTRO ELITE',
                300000,
                '#ff66d6',
                '★'
            )

            ON CONFLICT (rank_id)
            DO NOTHING
        `);

        /*
         * DEFAULT QUESTS
         */

        await client.query(`
            INSERT INTO quests
            (
                quest_id,
                title,
                description,
                reward,
                xp
            )
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

            ON CONFLICT (quest_id)
            DO NOTHING
        `);

        await client.query('COMMIT');

    } catch (error) {

        await client.query('ROLLBACK');

        throw error;

    } finally {

        client.release();
    }

    await ensureAdmin();
}

/*
 * HEALTH
 */

app.get('/api/health', async (_req, res) => {

    try {

        await pool.query('SELECT 1');

        res.json({
            ok: true,
            service: 'ASTRO ONLINE'
        });

    } catch (error) {

        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

/*
 * REGISTER
 */

app.post('/api/register', async (req, res) => {

    try {

        const username =
            cleanText(
                req.body.username,
                40
            );

        const email =
            normalizeEmail(
                req.body.email
            );

        const password =
            String(
                req.body.password || ''
            );

        if (username.length < 3) {

            return res.status(400).json({
                error:
                    'Никнейм должен быть минимум 3 символа.'
            });
        }

        if (!/^\S+@\S+\.\S+$/.test(email)) {

            return res.status(400).json({
                error:
                    'Некорректный email.'
            });
        }

        if (password.length < 6) {

            return res.status(400).json({
                error:
                    'Пароль должен быть минимум 6 символов.'
            });
        }

        const exists =
            await pool.query(`
                SELECT id
                FROM users
                WHERE email = $1
                   OR username = $2
                LIMIT 1
            `, [
                email,
                username
            ]);

        if (exists.rowCount) {

            return res.status(409).json({
                error:
                    'Такой email или никнейм уже занят.'
            });
        }

        const hash =
            await bcrypt.hash(
                password,
                12
            );

        const result =
            await pool.query(`
                INSERT INTO users
                (
                    username,
                    email,
                    password_hash
                )
                VALUES
                (
                    $1,
                    $2,
                    $3
                )
                RETURNING *
            `, [
                username,
                email,
                hash
            ]);

        const user =
            result.rows[0];

        res.json({
            token: signUser(user),
            user: publicUser(user)
        });

    } catch (error) {

        console.error(
            'REGISTER ERROR:',
            error
        );

        res.status(500).json({
            error:
                'Ошибка регистрации.'
        });
    }
});

/*
 * LOGIN
 */

app.post('/api/login', async (req, res) => {

    try {

        const email =
            normalizeEmail(
                req.body.email
            );

        const password =
            String(
                req.body.password || ''
            );

        const result =
            await pool.query(`
                SELECT *
                FROM users
                WHERE email = $1
                LIMIT 1
            `, [email]);

        const user =
            result.rows[0];

        if (
            !user ||
            !(await bcrypt.compare(
                password,
                user.password_hash
            ))
        ) {

            return res.status(401).json({
                error:
                    'Неверный email или пароль.'
            });
        }

        const rank =
            await getCurrentRank(
                user.id
            );

        res.json({
            token: signUser(user),
            user: publicUser(
                user,
                rank
            )
        });

    } catch (error) {

        console.error(
            'LOGIN ERROR:',
            error
        );

        res.status(500).json({
            error:
                'Ошибка входа.'
        });
    }
});

/*
 * PROFILE
 */

app.get(
    '/api/me',
    authRequired,
    async (req, res) => {

        try {

            const data =
                await getUserWithRank(
                    req.auth.id
                );

            if (!data) {

                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            res.json({
                user: publicUser(
                    data.user,
                    data.rank
                )
            });

        } catch (error) {

            console.error(
                'ME ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка загрузки профиля.'
            });
        }
    }
);

/*
 * RANKS
 */

app.get(
    '/api/ranks',
    async (_req, res) => {

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
                        id: r.id,
                        rankId: r.rank_id,
                        name: r.name,
                        title: r.title,
                        price: Number(r.price),
                        color: r.color,
                        icon: r.icon
                    }))
            });

        } catch (error) {

            console.error(
                'RANKS ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось загрузить ранги.'
            });
        }
    }
);

/*
 * BUY RANK
 */

app.post(
    '/api/ranks/:rankId/buy',
    authRequired,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const rankResult =
                await client.query(`
                    SELECT *
                    FROM ranks
                    WHERE rank_id = $1
                    LIMIT 1
                `, [
                    req.params.rankId
                ]);

            const rank =
                rankResult.rows[0];

            if (!rank) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

            const userResult =
                await client.query(`
                    SELECT *
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                `, [
                    req.auth.id
                ]);

            const user =
                userResult.rows[0];

            if (!user) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    error:
                        'Пользователь не найден.'
                });
            }

            const owned =
                await client.query(`
                    SELECT id
                    FROM user_ranks
                    WHERE user_id = $1
                      AND rank_id = $2
                    LIMIT 1
                `, [
                    user.id,
                    rank.id
                ]);

            if (owned.rowCount) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(400).json({
                    error:
                        'У вас уже есть этот ранг.'
                });
            }

            if (
                Number(user.balance) <
                Number(rank.price)
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(400).json({
                    error:
                        'Недостаточно средств.'
                });
            }

            await client.query(`
                UPDATE user_ranks
                SET is_active = FALSE
                WHERE user_id = $1
            `, [
                user.id
            ]);

            await client.query(`
                UPDATE users
                SET balance = balance - $1
                WHERE id = $2
            `, [
                rank.price,
                user.id
            ]);

            await client.query(`
                INSERT INTO user_ranks
                (
                    user_id,
                    rank_id,
                    is_active
                )
                VALUES
                (
                    $1,
                    $2,
                    TRUE
                )
            `, [
                user.id,
                rank.id
            ]);

            await client.query(
                'COMMIT'
            );

            const data =
                await getUserWithRank(
                    user.id
                );

            io.emit(
                'leaderboard:update'
            );

            res.json({
                user: publicUser(
                    data.user,
                    data.rank
                )
            });

        } catch (error) {

            await client.query(
                'ROLLBACK'
            );

            console.error(
                'BUY RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка покупки ранга.'
            });

        } finally {

            client.release();
        }
    }
);

/*
 * QUESTS
 */

app.get(
    '/api/quests',
    async (_req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT *
                    FROM quests
                    ORDER BY id DESC
                `);

            res.json({
                quests:
                    result.rows.map(q => ({
                        id: q.id,
                        questId: q.quest_id,
                        title: q.title,
                        description: q.description,
                        reward: Number(q.reward),
                        xp: Number(q.xp)
                    }))
            });

        } catch (error) {

            console.error(
                'QUESTS ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось загрузить квесты.'
            });
        }
    }
);

/*
 * CLAIM QUEST
 */

app.post(
    '/api/quests/:questId/claim',
    authRequired,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const questResult =
                await client.query(`
                    SELECT *
                    FROM quests
                    WHERE quest_id = $1
                    LIMIT 1
                `, [
                    req.params.questId
                ]);

            const quest =
                questResult.rows[0];

            if (!quest) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            const claim =
                await client.query(`
                    SELECT id
                    FROM quest_claims
                    WHERE user_id = $1
                      AND quest_id = $2
                    LIMIT 1
                `, [
                    req.auth.id,
                    quest.id
                ]);

            if (claim.rowCount) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(400).json({
                    error:
                        'Этот квест уже выполнен.'
                });
            }

            await client.query(`
                INSERT INTO quest_claims
                (
                    user_id,
                    quest_id
                )
                VALUES
                (
                    $1,
                    $2
                )
            `, [
                req.auth.id,
                quest.id
            ]);

            await client.query(`
                UPDATE users
                SET
                    balance = balance + $1,
                    xp = xp + $2
                WHERE id = $3
            `, [
                quest.reward,
                quest.xp,
                req.auth.id
            ]);

            await client.query(
                'COMMIT'
            );

            const data =
                await getUserWithRank(
                    req.auth.id
                );

            io.emit(
                'leaderboard:update'
            );

            res.json({
                reward:
                    Number(quest.reward),

                xp:
                    Number(quest.xp),

                user:
                    publicUser(
                        data.user,
                        data.rank
                    )
            });

        } catch (error) {

            await client.query(
                'ROLLBACK'
            );

            console.error(
                'CLAIM QUEST ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка выполнения квеста.'
            });

        } finally {

            client.release();
        }
    }
);

/*
 * LEADERBOARD
 */

app.get(
    '/api/leaderboard',
    async (_req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT
                        id,
                        username,
                        elo,
                        xp,
                        wins
                    FROM users
                    ORDER BY
                        elo DESC,
                        wins DESC,
                        xp DESC,
                        id ASC
                    LIMIT 100
                `);

            res.json({
                players:
                    result.rows.map(u => ({
                        id: u.id,
                        username: u.username,
                        elo: Number(u.elo),
                        xp: Number(u.xp),
                        wins: Number(u.wins)
                    }))
            });

        } catch (error) {

            console.error(
                'LEADERBOARD ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось загрузить рейтинг.'
            });
        }
    }
);

/*
 * ADMIN USERS
 */

app.get(
    '/api/admin/users',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const search =
                cleanText(
                    req.query.search,
                    80
                );

            let result;

            if (search) {

                result =
                    await pool.query(`
                        SELECT
                            id,
                            username,
                            email,
                            role,
                            balance,
                            elo,
                            xp,
                            wins
                        FROM users
                        WHERE
                            username ILIKE $1
                            OR email ILIKE $1
                        ORDER BY
                            elo DESC,
                            id ASC
                        LIMIT 100
                    `, [
                        `%${search}%`
                    ]);

            } else {

                result =
                    await pool.query(`
                        SELECT
                            id,
                            username,
                            email,
                            role,
                            balance,
                            elo,
                            xp,
                            wins
                        FROM users
                        ORDER BY
                            elo DESC,
                            id ASC
                        LIMIT 100
                    `);
            }

            res.json({
                users:
                    result.rows.map(u => ({
                        id: u.id,
                        username: u.username,
                        email: u.email,
                        role: u.role,
                        balance: Number(u.balance),
                        elo: Number(u.elo),
                        xp: Number(u.xp),
                        wins: Number(u.wins)
                    }))
            });

        } catch (error) {

            console.error(
                'ADMIN USERS ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка загрузки игроков.'
            });
        }
    }
);

/*
 * ADMIN UPDATE PLAYER
 */

app.put(
    '/api/admin/users/:id',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!Number.isInteger(id)) {

                return res.status(400).json({
                    error:
                        'Некорректный ID игрока.'
                });
            }

            const current =
                await getUserById(id);

            if (!current) {

                return res.status(404).json({
                    error:
                        'Игрок не найден.'
                });
            }

            const elo =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.elo,
                            Number(current.elo)
                        )
                    )
                );

            const wins =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.wins,
                            Number(current.wins)
                        )
                    )
                );

            const balance =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.balance,
                            Number(current.balance)
                        )
                    )
                );

            const xp =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.xp,
                            Number(current.xp)
                        )
                    )
                );

            await pool.query(`
                UPDATE users
                SET
                    elo = $1,
                    wins = $2,
                    balance = $3,
                    xp = $4
                WHERE id = $5
            `, [
                elo,
                wins,
                balance,
                xp,
                id
            ]);

            io.emit(
                'leaderboard:update'
            );

            const data =
                await getUserWithRank(id);

            res.json({
                user:
                    publicUser(
                        data.user,
                        data.rank
                    )
            });

        } catch (error) {

            console.error(
                'ADMIN USER UPDATE ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка сохранения игрока.'
            });
        }
    }
);

/*
 * ADMIN RANKS
 */

app.get(
    '/api/admin/ranks',
    authRequired,
    adminRequired,
    async (_req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT *
                    FROM ranks
                    ORDER BY id DESC
                `);

            res.json({
                ranks:
                    result.rows
            });

        } catch (error) {

            console.error(
                'ADMIN RANKS ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка загрузки рангов.'
            });
        }
    }
);

app.post(
    '/api/admin/ranks',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const rankId =
                cleanText(
                    req.body.rankId,
                    80
                )
                .toLowerCase()
                .replace(
                    /[^a-z0-9_-]/g,
                    '-'
                );

            const name =
                cleanText(
                    req.body.name,
                    80
                );

            const title =
                cleanText(
                    req.body.title,
                    120
                );

            const price =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.price,
                            0
                        )
                    )
                );

            const color =
                cleanText(
                    req.body.color,
                    30
                ) || '#9b7cff';

            const icon =
                cleanText(
                    req.body.icon,
                    20
                ) || '★';

            if (!rankId || !name) {

                return res.status(400).json({
                    error:
                        'ID и название ранга обязательны.'
                });
            }

            const result =
                await pool.query(`
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
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    RETURNING *
                `, [
                    rankId,
                    name,
                    title,
                    price,
                    color,
                    icon
                ]);

            io.emit(
                'ranks:update'
            );

            res.json({
                rank:
                    result.rows[0]
            });

        } catch (error) {

            console.error(
                'CREATE RANK ERROR:',
                error
            );

            if (
                error.code === '23505'
            ) {

                return res.status(409).json({
                    error:
                        'Такой ID ранга уже существует.'
                });
            }

            res.status(500).json({
                error:
                    'Ошибка создания ранга.'
            });
        }
    }
);

app.delete(
    '/api/admin/ranks/:id',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!Number.isInteger(id)) {

                return res.status(400).json({
                    error:
                        'Некорректный ID ранга.'
                });
            }

            const result =
                await pool.query(`
                    DELETE FROM ranks
                    WHERE id = $1
                    RETURNING id
                `, [
                    id
                ]);

            if (!result.rowCount) {

                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

            io.emit(
                'ranks:update'
            );

            res.json({
                ok: true
            });

        } catch (error) {

            console.error(
                'DELETE RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка удаления ранга.'
            });
        }
    }
);

/*
 * ADMIN GIVE RANK
 */

app.post(
    '/api/admin/users/:userId/rank',
    authRequired,
    adminRequired,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            const userId =
                Number(req.params.userId);

            const rankId =
                Number(req.body.rankId);

            if (
                !Number.isInteger(userId) ||
                !Number.isInteger(rankId)
            ) {

                return res.status(400).json({
                    error:
                        'Некорректный ID игрока или ранга.'
                });
            }

            await client.query(
                'BEGIN'
            );

            const rank =
                await client.query(`
                    SELECT *
                    FROM ranks
                    WHERE id = $1
                `, [
                    rankId
                ]);

            const user =
                await client.query(`
                    SELECT *
                    FROM users
                    WHERE id = $1
                `, [
                    userId
                ]);

            if (
                !rank.rowCount ||
                !user.rowCount
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    error:
                        'Игрок или ранг не найден.'
                });
            }

            await client.query(`
                UPDATE user_ranks
                SET is_active = FALSE
                WHERE user_id = $1
            `, [
                userId
            ]);

            await client.query(`
                INSERT INTO user_ranks
                (
                    user_id,
                    rank_id,
                    is_active
                )
                VALUES
                (
                    $1,
                    $2,
                    TRUE
                )
                ON CONFLICT
                (
                    user_id,
                    rank_id
                )
                DO UPDATE SET
                    is_active = TRUE,
                    created_at = NOW()
            `, [
                userId,
                rankId
            ]);

            await client.query(
                'COMMIT'
            );

            res.json({
                ok: true
            });

        } catch (error) {

            await client.query(
                'ROLLBACK'
            );

            console.error(
                'ASSIGN RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка выдачи ранга.'
            });

        } finally {

            client.release();
        }
    }
);

/*
 * ADMIN REMOVE RANK
 */

app.delete(
    '/api/admin/users/:userId/rank',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const userId =
                Number(req.params.userId);

            if (!Number.isInteger(userId)) {

                return res.status(400).json({
                    error:
                        'Некорректный ID игрока.'
                });
            }

            await pool.query(`
                UPDATE user_ranks
                SET is_active = FALSE
                WHERE user_id = $1
            `, [
                userId
            ]);

            res.json({
                ok: true
            });

        } catch (error) {

            console.error(
                'REMOVE RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка снятия ранга.'
            });
        }
    }
);

/*
 * ADMIN QUESTS
 */

app.get(
    '/api/admin/quests',
    authRequired,
    adminRequired,
    async (_req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT *
                    FROM quests
                    ORDER BY id DESC
                `);

            res.json({
                quests:
                    result.rows
            });

        } catch (error) {

            console.error(
                'ADMIN QUESTS ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка загрузки квестов.'
            });
        }
    }
);

app.post(
    '/api/admin/quests',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const questId =
                cleanText(
                    req.body.questId,
                    80
                )
                .toLowerCase()
                .replace(
                    /[^a-z0-9_-]/g,
                    '-'
                );

            const title =
                cleanText(
                    req.body.title,
                    120
                );

            const description =
                cleanText(
                    req.body.description,
                    1000
                );

            const reward =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.reward,
                            0
                        )
                    )
                );

            const xp =
                Math.max(
                    0,
                    Math.round(
                        positiveNumber(
                            req.body.xp,
                            0
                        )
                    )
                );

            if (
                !questId ||
                !title
            ) {

                return res.status(400).json({
                    error:
                        'ID и название квеста обязательны.'
                });
            }

            const result =
                await pool.query(`
                    INSERT INTO quests
                    (
                        quest_id,
                        title,
                        description,
                        reward,
                        xp
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
                `, [
                    questId,
                    title,
                    description,
                    reward,
                    xp
                ]);

            io.emit(
                'quests:update'
            );

            res.json({
                quest:
                    result.rows[0]
            });

        } catch (error) {

            console.error(
                'CREATE QUEST ERROR:',
                error
            );

            if (
                error.code === '23505'
            ) {

                return res.status(409).json({
                    error:
                        'Такой ID квеста уже существует.'
                });
            }

            res.status(500).json({
                error:
                    'Ошибка создания квеста.'
            });
        }
    }
);

app.delete(
    '/api/admin/quests/:id',
    authRequired,
    adminRequired,
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!Number.isInteger(id)) {

                return res.status(400).json({
                    error:
                        'Некорректный ID квеста.'
                });
            }

            const result =
                await pool.query(`
                    DELETE FROM quests
                    WHERE id = $1
                    RETURNING id
                `, [
                    id
                ]);

            if (!result.rowCount) {

                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            io.emit(
                'quests:update'
            );

            res.json({
                ok: true
            });

        } catch (error) {

            console.error(
                'DELETE QUEST ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка удаления квеста.'
            });
        }
    }
);

/*
 * FRONTEND
 */

app.get('*', (req, res) => {

    if (
        req.path.startsWith('/api/')
    ) {

        return res.status(404).json({
            error:
                'API route not found.'
        });
    }

    res.sendFile(
        path.join(
            __dirname,
            'public',
            'index.html'
        )
    );
});

/*
 * ERROR HANDLER
 */

app.use(
    (err, _req, res, _next) => {

        console.error(
            'UNHANDLED ERROR:',
            err
        );

        res.status(500).json({
            error:
                'Внутренняя ошибка сервера.'
        });
    }
);

/*
 * SOCKET.IO
 */

io.on(
    'connection',
    socket => {

        console.log(
            'ASTRO: client connected',
            socket.id
        );

        socket.on(
            'disconnect',
            () => {

                console.log(
                    'ASTRO: client disconnected',
                    socket.id
                );
            }
        );
    }
);

/*
 * START
 */

async function start() {

    try {

        await pool.query(
            'SELECT 1'
        );

        console.log(
            'ASTRO: PostgreSQL подключен.'
        );

        await initDatabase();

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

    } catch (error) {

        console.error(
            'FATAL SERVER ERROR:'
        );

        console.error(
            error
        );

        process.exit(1);
    }
}

process.on(
    'unhandledRejection',
    error => {

        console.error(
            'UNHANDLED REJECTION:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            'UNCAUGHT EXCEPTION:',
            error
        );

        process.exit(1);
    }
);

start();
```
