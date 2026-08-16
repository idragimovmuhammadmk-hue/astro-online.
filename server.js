require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET =
    process.env.JWT_SECRET ||
    'astro-super-secret-change-this';

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL ||
    'admin@astro.local';

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    'admin12345';

if (!DATABASE_URL) {
    console.error('DATABASE_URL не задан!');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
        DATABASE_URL &&
        /localhost|127\.0\.0\.1/.test(DATABASE_URL)
            ? false
            : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '2mb' }));

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

/* =========================================================
   DEFAULT DATA
========================================================= */

const DEFAULT_RANKS = [
    {
        rankId: 'bronze',
        name: 'BRONZE',
        title: 'Бронзовый',
        price: 5000,
        color: '#cd7f32',
        icon: '◆'
    },
    {
        rankId: 'silver',
        name: 'SILVER',
        title: 'Серебряный',
        price: 15000,
        color: '#b9c3d0',
        icon: '◇'
    },
    {
        rankId: 'gold',
        name: 'GOLD',
        title: 'Золотой',
        price: 35000,
        color: '#ffd45a',
        icon: '✦'
    },
    {
        rankId: 'diamond',
        name: 'DIAMOND',
        title: 'Алмазный',
        price: 75000,
        color: '#6ee7ff',
        icon: '✧'
    },
    {
        rankId: 'master',
        name: 'MASTER',
        title: 'Мастер',
        price: 150000,
        color: '#c084fc',
        icon: '✹'
    },
    {
        rankId: 'astro',
        name: 'ASTRO',
        title: 'ASTRO ELITE',
        price: 300000,
        color: '#ff6bd6',
        icon: '★'
    }
];

const DEFAULT_QUESTS = [
    {
        questId: 'daily-login',
        title: 'Войти в систему',
        description:
            'Открой профиль и забери ежедневную награду.',
        reward: 50,
        xp: 25
    },
    {
        questId: 'daily-explore',
        title: 'Исследователь',
        description:
            'Посети разделы ASTRO и изучи новый сезон.',
        reward: 100,
        xp: 50
    },
    {
        questId: 'daily-elite',
        title: 'Elite Protocol',
        description:
            'Выполни особое задание сезона.',
        reward: 250,
        xp: 100
    }
];

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {

    if (!DATABASE_URL) {
        throw new Error(
            'DATABASE_URL не задан в Environment Variables.'
        );
    }

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

            is_admin BOOLEAN NOT NULL DEFAULT false,

            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

            last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

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

            color TEXT NOT NULL DEFAULT '#ffffff',

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
        MIGRATION:
        если users была создана старой версией
    */

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT 1000
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS elo BIGINT NOT NULL DEFAULT 1000
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS wins BIGINT NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS owned_ranks JSONB NOT NULL DEFAULT '[]'::jsonb
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS claimed_quests JSONB NOT NULL DEFAULT '{}'::jsonb
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb
    `);

    /*
        DEFAULT RANKS
    */

    for (const rank of DEFAULT_RANKS) {

        await pool.query(
            `
            INSERT INTO ranks
                (rank_id,name,title,price,color,icon)
            VALUES
                ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (rank_id)
            DO NOTHING
            `,
            [
                rank.rankId,
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

    for (const quest of DEFAULT_QUESTS) {

        await pool.query(
            `
            INSERT INTO quests
                (quest_id,title,description,reward,xp)
            VALUES
                ($1,$2,$3,$4,$5)
            ON CONFLICT (quest_id)
            DO NOTHING
            `,
            [
                quest.questId,
                quest.title,
                quest.description,
                quest.reward,
                quest.xp
            ]
        );
    }

    /*
        ADMIN ACCOUNT

        Если его нет — создаём автоматически.
    */

    const adminHash =
        await bcrypt.hash(
            ADMIN_PASSWORD,
            12
        );

    const adminResult =
        await pool.query(
            `
            SELECT id
            FROM users
            WHERE lower(email)=lower($1)
            LIMIT 1
            `,
            [ADMIN_EMAIL]
        );

    if (!adminResult.rows.length) {

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
                wins,
                is_admin
            )
            VALUES
            (
                $1,
                $2,
                $3,
                1000000,
                100000,
                99999,
                9999,
                true
            )
            `,
            [
                ADMIN_EMAIL,
                'ASTRO_ADMIN',
                adminHash
            ]
        );

        console.log(
            'ADMIN ACCOUNT CREATED:',
            ADMIN_EMAIL
        );

    } else {

        await pool.query(
            `
            UPDATE users
            SET
                is_admin=true,
                password_hash=$1
            WHERE lower(email)=lower($2)
            `,
            [
                adminHash,
                ADMIN_EMAIL
            ]
        );
    }

    console.log('ASTRO DATABASE READY');
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
            user.owned_ranks || [],

        claimedQuests:
            user.claimed_quests || {},

        history:
            user.history || [],

        isAdmin:
            Boolean(user.is_admin),

        createdAt:
            user.created_at,

        lastLoginAt:
            user.last_login_at
    };
}

function tokenFor(user) {

    return jwt.sign(
        {
            id: user.id
        },
        JWT_SECRET,
        {
            expiresIn: '30d'
        }
    );
}

async function getUserById(id) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM users
            WHERE id=$1
            `,
            [id]
        );

    return result.rows[0];
}

/* =========================================================
   AUTH
========================================================= */

async function auth(req, res, next) {

    try {

        const header =
            req.headers.authorization || '';

        if (!header.startsWith('Bearer ')) {

            return res.status(401).json({
                error: 'Требуется вход.'
            });
        }

        const token =
            header.slice(7);

        const payload =
            jwt.verify(
                token,
                JWT_SECRET
            );

        const user =
            await getUserById(
                payload.id
            );

        if (!user) {

            return res.status(401).json({
                error: 'Пользователь не найден.'
            });
        }

        req.user = user;

        next();

    } catch (error) {

        return res.status(401).json({
            error: 'Сессия недействительна.'
        });
    }
}

async function adminAuth(
    req,
    res,
    next
) {

    try {

        await auth(
            req,
            res,
            async () => {

                if (!req.user.is_admin) {

                    return res.status(403).json({
                        error:
                            'Доступ разрешён только администратору.'
                    });
                }

                next();
            }
        );

    } catch (error) {

        return res.status(403).json({
            error: 'Нет доступа.'
        });
    }
}

/* =========================================================
   SOCKET
========================================================= */

function broadcastAll() {

    io.emit(
        'leaderboard:update'
    );

    io.emit(
        'ranks:update'
    );

    io.emit(
        'quests:update'
    );
}

/* =========================================================
   BASIC
========================================================= */

app.get(
    '/api/status',
    (req, res) => {

        res.json({
            online: true,
            name: 'ASTRO ONLINE'
        });
    }
);

/* =========================================================
   AUTH API
========================================================= */

app.post(
    '/api/register',
    async (req, res) => {

        try {

            const {
                username,
                email,
                password
            } = req.body || {};

            const n =
                String(
                    username || ''
                ).trim();

            const e =
                String(
                    email || ''
                )
                    .trim()
                    .toLowerCase();

            const p =
                String(
                    password || ''
                );

            if (
                !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                    n
                )
            ) {

                return res.status(400).json({
                    error:
                        'Никнейм должен содержать 3–20 символов.'
                });
            }

            if (
                !/^\S+@\S+\.\S+$/.test(e)
            ) {

                return res.status(400).json({
                    error:
                        'Введите корректный email.'
                });
            }

            if (p.length < 8) {

                return res.status(400).json({
                    error:
                        'Пароль должен содержать минимум 8 символов.'
                });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE
                        lower(email)=lower($1)
                        OR lower(username)=lower($2)
                    LIMIT 1
                    `,
                    [e, n]
                );

            if (exists.rows.length) {

                return res.status(409).json({
                    error:
                        'Email или никнейм уже занят.'
                });
            }

            const hash =
                await bcrypt.hash(
                    p,
                    12
                );

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
                        e,
                        n,
                        hash
                    ]
                );

            const user =
                result.rows[0];

            broadcastAll();

            res.json({
                token:
                    tokenFor(user),

                user:
                    publicUser(user)
            });

        } catch (error) {

            console.error(
                'REGISTER ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось создать аккаунт.'
            });
        }
    }
);

app.post(
    '/api/login',
    async (req, res) => {

        try {

            const {
                email,
                password
            } = req.body || {};

            const e =
                String(
                    email || ''
                )
                    .trim()
                    .toLowerCase();

            const p =
                String(
                    password || ''
                );

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE lower(email)=lower($1)
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
                        'Неверный email или пароль.'
                });
            }

            await pool.query(
                `
                UPDATE users
                SET last_login_at=now()
                WHERE id=$1
                `,
                [user.id]
            );

            const fresh =
                await getUserById(
                    user.id
                );

            res.json({
                token:
                    tokenFor(fresh),

                user:
                    publicUser(fresh)
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
    }
);

/* =========================================================
   ME
========================================================= */

app.get(
    '/api/me',
    auth,
    (req, res) => {

        res.json({
            user:
                publicUser(req.user)
        });
    }
);

/* =========================================================
   PROFILE
========================================================= */

app.put(
    '/api/profile',
    auth,
    async (req, res) => {

        try {

            const username =
                String(
                    req.body?.username || ''
                ).trim();

            if (
                !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
                    username
                )
            ) {

                return res.status(400).json({
                    error:
                        'Никнейм должен содержать 3–20 символов.'
                });
            }

            const duplicate =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE
                        lower(username)=lower($1)
                        AND id<>$2
                    LIMIT 1
                    `,
                    [
                        username,
                        req.user.id
                    ]
                );

            if (duplicate.rows.length) {

                return res.status(409).json({
                    error:
                        'Такой никнейм уже занят.'
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

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                'PROFILE ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось сохранить профиль.'
            });
        }
    }
);

/* =========================================================
   RANKS
========================================================= */

app.get(
    '/api/ranks',
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    ORDER BY price ASC, created_at ASC
                    `
                );

            res.json({
                ranks:
                    result.rows.map(
                        rank => ({
                            id:
                                rank.id,

                            rankId:
                                rank.rank_id,

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
                    )
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

/* =========================================================
   BUY RANK
========================================================= */

app.post(
    '/api/ranks/:id/buy',
    auth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            const rankResult =
                await client.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE
                        rank_id=$1
                        OR id::text=$1
                    LIMIT 1
                    `,
                    [req.params.id]
                );

            const rank =
                rankResult.rows[0];

            if (!rank) {

                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

            await client.query(
                'BEGIN'
            );

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
                owned.includes(
                    rank.rank_id
                )
            ) {

                throw new Error(
                    'Этот ранг уже куплен.'
                );
            }

            if (
                Number(user.balance) <
                Number(rank.price)
            ) {

                throw new Error(
                    'Недостаточно денег.'
                );
            }

            owned.push(
                rank.rank_id
            );

            const history = [
                ...(user.history || []),

                {
                    title:
                        `Покупка ранга · ${rank.name}`,

                    amount:
                        -Number(
                            rank.price
                        ),

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
                        owned_ranks=$2,
                        history=$3

                    WHERE id=$4

                    RETURNING *
                    `,
                    [
                        Number(
                            rank.price
                        ),

                        JSON.stringify(
                            owned
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

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        updated.rows[0]
                    ),

                rank: {
                    rankId:
                        rank.rank_id,

                    name:
                        rank.name
                }
            });

        } catch (error) {

            await client.query(
                'ROLLBACK'
            );

            res.status(400).json({
                error:
                    error.message
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
    '/api/quests',
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
                    result.rows.map(
                        quest => ({
                            id:
                                quest.id,

                            questId:
                                quest.quest_id,

                            title:
                                quest.title,

                            description:
                                quest.description,

                            reward:
                                Number(
                                    quest.reward
                                ),

                            xp:
                                Number(
                                    quest.xp
                                )
                        })
                    )
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

/* =========================================================
   CLAIM QUEST
========================================================= */

app.post(
    '/api/quests/:id/claim',
    auth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            const questResult =
                await client.query(
                    `
                    SELECT *
                    FROM quests
                    WHERE
                        quest_id=$1
                        OR id::text=$1
                    LIMIT 1
                    `,
                    [req.params.id]
                );

            const quest =
                questResult.rows[0];

            if (!quest) {

                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            await client.query(
                'BEGIN'
            );

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
                user.claimed_quests || {};

            if (
                claimed[quest.quest_id]
            ) {

                throw new Error(
                    'Этот квест уже получен.'
                );
            }

            claimed[
                quest.quest_id
            ] = true;

            const history = [
                ...(user.history || []),

                {
                    title:
                        `Квест · ${quest.title}`,

                    amount:
                        Number(
                            quest.reward
                        ),

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
                        claimed_quests=$3,
                        history=$4

                    WHERE id=$5

                    RETURNING *
                    `,
                    [
                        Number(
                            quest.reward
                        ),

                        Number(
                            quest.xp
                        ),

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

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        updated.rows[0]
                    ),

                reward:
                    Number(
                        quest.reward
                    ),

                xp:
                    Number(
                        quest.xp
                    )
            });

        } catch (error) {

            await client.query(
                'ROLLBACK'
            );

            res.status(400).json({
                error:
                    error.message
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

                    WHERE is_admin=false

                    ORDER BY
                        elo DESC,
                        xp DESC,
                        wins DESC
                    `
                );

            res.json({
                players:
                    result.rows.map(
                        user => ({
                            id:
                                user.id,

                            username:
                                user.username,

                            elo:
                                Number(
                                    user.elo
                                ),

                            xp:
                                Number(
                                    user.xp
                                ),

                            wins:
                                Number(
                                    user.wins
                                ),

                            ownedRanks:
                                user.owned_ranks || []
                        })
                    )
            });

        } catch (error) {

            console.error(
                'LEADERBOARD ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Ошибка рейтинга.'
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

            const search =
                String(
                    req.query.search || ''
                ).trim();

            let result;

            if (search) {

                result =
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
                            is_admin

                        FROM users

                        WHERE
                            username ILIKE $1
                            OR email ILIKE $1

                        ORDER BY elo DESC

                        LIMIT 100
                        `,
                        [
                            `%${search}%`
                        ]
                    );

            } else {

                result =
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
                            is_admin

                        FROM users

                        ORDER BY elo DESC

                        LIMIT 100
                        `
                    );
            }

            res.json({
                users:
                    result.rows.map(
                        user => ({
                            id:
                                user.id,

                            email:
                                user.email,

                            username:
                                user.username,

                            balance:
                                Number(
                                    user.balance
                                ),

                            xp:
                                Number(
                                    user.xp
                                ),

                            elo:
                                Number(
                                    user.elo
                                ),

                            wins:
                                Number(
                                    user.wins
                                ),

                            ownedRanks:
                                user.owned_ranks || [],

                            isAdmin:
                                Boolean(
                                    user.is_admin
                                )
                        })
                    )
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

/* =========================================================
   ADMIN - EDIT USER
========================================================= */

app.put(
    '/api/admin/users/:id',
    adminAuth,
    async (req, res) => {

        try {

            const id =
                req.params.id;

            const elo =
                Number(
                    req.body?.elo
                );

            const wins =
                Number(
                    req.body?.wins
                );

            const balance =
                Number(
                    req.body?.balance
                );

            const xp =
                req.body?.xp !== undefined
                    ? Number(
                        req.body.xp
                    )
                    : null;

            if (
                !Number.isFinite(elo) ||
                !Number.isFinite(wins) ||
                !Number.isFinite(balance)
            ) {

                return res.status(400).json({
                    error:
                        'Неверные значения.'
                });
            }

            let result;

            if (xp !== null) {

                result =
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
                            Math.max(
                                0,
                                Math.floor(
                                    elo
                                )
                            ),

                            Math.max(
                                0,
                                Math.floor(
                                    wins
                                )
                            ),

                            Math.max(
                                0,
                                Math.floor(
                                    balance
                                )
                            ),

                            Math.max(
                                0,
                                Math.floor(
                                    xp
                                )
                            ),

                            id
                        ]
                    );

            } else {

                result =
                    await pool.query(
                        `
                        UPDATE users

                        SET
                            elo=$1,
                            wins=$2,
                            balance=$3

                        WHERE id=$4

                        RETURNING *
                        `,
                        [
                            Math.max(
                                0,
                                Math.floor(
                                    elo
                                )
                            ),

                            Math.max(
                                0,
                                Math.floor(
                                    wins
                                )
                            ),

                            Math.max(
                                0,
                                Math.floor(
                                    balance
                                )
                            ),

                            id
                        ]
                    );
            }

            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        'Игрок не найден.'
                });
            }

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                'ADMIN UPDATE USER ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось изменить игрока.'
            });
        }
    }
);

/* =========================================================
   ADMIN - RANKS
========================================================= */

app.get(
    '/api/admin/ranks',
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
                    result.rows
            });

        } catch (error) {

            res.status(500).json({
                error:
                    'Ошибка загрузки рангов.'
            });
        }
    }
);

app.post(
    '/api/admin/ranks',
    adminAuth,
    async (req, res) => {

        try {

            const {
                rankId,
                name,
                title,
                price,
                color,
                icon
            } = req.body || {};

            const id =
                String(
                    rankId || ''
                ).trim();

            const rankName =
                String(
                    name || ''
                ).trim();

            const rankTitle =
                String(
                    title || ''
                ).trim();

            const rankPrice =
                Number(price);

            const rankColor =
                String(
                    color || '#ffffff'
                ).trim();

            const rankIcon =
                String(
                    icon || '★'
                ).trim();

            if (!id) {

                return res.status(400).json({
                    error:
                        'Укажи ID ранга.'
                });
            }

            if (!rankName) {

                return res.status(400).json({
                    error:
                        'Укажи название ранга.'
                });
            }

            if (!rankTitle) {

                return res.status(400).json({
                    error:
                        'Укажи титул ранга.'
                });
            }

            if (
                !Number.isFinite(
                    rankPrice
                ) ||
                rankPrice < 0
            ) {

                return res.status(400).json({
                    error:
                        'Неверная цена.'
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
                        id,
                        rankName,
                        rankTitle,
                        Math.floor(
                            rankPrice
                        ),
                        rankColor,
                        rankIcon
                    ]
                );

            broadcastAll();

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
                    'Не удалось создать ранг.'
            });
        }
    }
);

app.delete(
    '/api/admin/ranks/:id',
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM ranks

                    WHERE
                        id::text=$1
                        OR rank_id=$1

                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        'Ранг не найден.'
                });
            }

            broadcastAll();

            res.json({
                success: true
            });

        } catch (error) {

            console.error(
                'DELETE RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось удалить ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE / REMOVE RANK
========================================================= */

app.post(
    '/api/admin/users/:id/ranks/:rankId',
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
                        'Игрок не найден.'
                });
            }

            const rankResult =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE
                        rank_id=$1
                        OR id::text=$1
                    LIMIT 1
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

            const owned =
                Array.isArray(
                    user.owned_ranks
                )
                    ? user.owned_ranks
                    : [];

            if (
                !owned.includes(
                    rank.rank_id
                )
            ) {

                owned.push(
                    rank.rank_id
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE users

                    SET owned_ranks=$1

                    WHERE id=$2

                    RETURNING *
                    `,
                    [
                        JSON.stringify(
                            owned
                        ),
                        user.id
                    ]
                );

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                'GIVE RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось выдать ранг.'
            });
        }
    }
);

app.delete(
    '/api/admin/users/:id/ranks/:rankId',
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
                        'Игрок не найден.'
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
                    rankId =>
                        rankId !==
                        req.params.rankId
                );

            const result =
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

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                'REMOVE RANK ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось снять ранг.'
            });
        }
    }
);

/* =========================================================
   ADMIN - QUESTS
========================================================= */

app.get(
    '/api/admin/quests',
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
                    result.rows
            });

        } catch (error) {

            res.status(500).json({
                error:
                    'Ошибка загрузки квестов.'
            });
        }
    }
);

app.post(
    '/api/admin/quests',
    adminAuth,
    async (req, res) => {

        try {

            const {
                questId,
                title,
                description,
                reward,
                xp
            } = req.body || {};

            const id =
                String(
                    questId || ''
                ).trim();

            const questTitle =
                String(
                    title || ''
                ).trim();

            const questDescription =
                String(
                    description || ''
                ).trim();

            const questReward =
                Number(reward);

            const questXp =
                Number(xp);

            if (!id) {

                return res.status(400).json({
                    error:
                        'Укажи ID квеста.'
                });
            }

            if (!questTitle) {

                return res.status(400).json({
                    error:
                        'Укажи название квеста.'
                });
            }

            if (
                !Number.isFinite(
                    questReward
                ) ||
                questReward < 0
            ) {

                return res.status(400).json({
                    error:
                        'Неверная награда.'
                });
            }

            if (
                !Number.isFinite(
                    questXp
                ) ||
                questXp < 0
            ) {

                return res.status(400).json({
                    error:
                        'Неверный XP.'
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
                        id,
                        questTitle,
                        questDescription,
                        Math.floor(
                            questReward
                        ),
                        Math.floor(
                            questXp
                        )
                    ]
                );

            broadcastAll();

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
                    'Не удалось создать квест.'
            });
        }
    }
);

app.delete(
    '/api/admin/quests/:id',
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM quests

                    WHERE
                        id::text=$1
                        OR quest_id=$1

                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            broadcastAll();

            res.json({
                success: true
            });

        } catch (error) {

            console.error(
                'DELETE QUEST ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось удалить квест.'
            });
        }
    }
);

/* =========================================================
   ADMIN - GIVE QUEST
========================================================= */

app.post(
    '/api/admin/users/:id/quests/:questId',
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
                        'Игрок не найден.'
                });
            }

            const questResult =
                await pool.query(
                    `
                    SELECT *
                    FROM quests
                    WHERE
                        quest_id=$1
                        OR id::text=$1
                    LIMIT 1
                    `,
                    [req.params.questId]
                );

            const quest =
                questResult.rows[0];

            if (!quest) {

                return res.status(404).json({
                    error:
                        'Квест не найден.'
                });
            }

            const claimed =
                user.claimed_quests || {};

            claimed[
                quest.quest_id
            ] = true;

            const result =
                await pool.query(
                    `
                    UPDATE users

                    SET claimed_quests=$1

                    WHERE id=$2

                    RETURNING *
                    `,
                    [
                        JSON.stringify(
                            claimed
                        ),
                        user.id
                    ]
                );

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                'GIVE QUEST ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось выдать квест.'
            });
        }
    }
);

/* =========================================================
   ADMIN - MONEY / ELO / WINS SHORTCUTS
========================================================= */

app.post(
    '/api/admin/users/:id/give',
    adminAuth,
    async (req, res) => {

        try {

            const money =
                Number(
                    req.body?.balance || 0
                );

            const elo =
                Number(
                    req.body?.elo || 0
                );

            const wins =
                Number(
                    req.body?.wins || 0
                );

            const xp =
                Number(
                    req.body?.xp || 0
                );

            const result =
                await pool.query(
                    `
                    UPDATE users

                    SET
                        balance=balance+$1,
                        elo=elo+$2,
                        wins=wins+$3,
                        xp=xp+$4

                    WHERE id=$5

                    RETURNING *
                    `,
                    [
                        Math.floor(money),
                        Math.floor(elo),
                        Math.floor(wins),
                        Math.floor(xp),
                        req.params.id
                    ]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        'Игрок не найден.'
                });
            }

            broadcastAll();

            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                'ADMIN GIVE ERROR:',
                error
            );

            res.status(500).json({
                error:
                    'Не удалось выдать награду.'
            });
        }
    }
);

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on(
    'connection',
    socket => {

        console.log(
            'Socket connected:',
            socket.id
        );

        socket.on(
            'disconnect',
            () => {

                console.log(
                    'Socket disconnected:',
                    socket.id
                );
            }
        );
    }
);

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.get(
    '*',
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                'public',
                'index.html'
            )
        );
    }
);

/* =========================================================
   START
========================================================= */

async function start() {

    try {

        await initDatabase();

        server.listen(
            PORT,
            '0.0.0.0',
            () => {

                console.log(
                    `ASTRO ONLINE listening on port ${PORT}`
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

        console.error(error);

        process.exit(1);
    }
}

start();
