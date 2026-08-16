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
const JWT_SECRET = process.env.JWT_SECRET || "astro-secret";

if (!DATABASE_URL) {
    console.error("DATABASE_URL не найден!");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   DEFAULT DATA
========================= */

const DEFAULT_RANKS = [
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

const DEFAULT_QUESTS = [
    {
        id: "daily-login",
        title: "Войти в систему",
        reward: 50,
        xp: 25,
        description: "Открой профиль и забери ежедневную награду."
    },
    {
        id: "daily-explore",
        title: "Исследователь",
        reward: 100,
        xp: 50,
        description: "Посети разделы ASTRO и изучи новый сезон."
    },
    {
        id: "daily-elite",
        title: "Elite Protocol",
        reward: 250,
        xp: 100,
        description: "Выполни особое задание сезона."
    }
];

/* =========================
   HELPERS
========================= */

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function cleanId(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function userJSON(u) {
    return {
        id: u.id,
        email: u.email,
        username: u.username,
        balance: Number(u.balance || 0),
        xp: Number(u.xp || 0),
        elo: Number(u.elo || 0),
        wins: Number(u.wins || 0),
        ownedRanks: Array.isArray(u.owned_ranks)
            ? u.owned_ranks
            : [],
        claimedQuests: u.claimed_quests || {},
        history: Array.isArray(u.history)
            ? u.history
            : [],
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at
    };
}

function rankJSON(r) {
    return {
        id: r.id,
        rankId: r.id,
        name: r.name,
        title: r.title,
        price: Number(r.price || 0),
        color: r.color,
        icon: r.icon
    };
}

function questJSON(q) {
    return {
        id: q.id,
        questId: q.id,
        title: q.title,
        reward: Number(q.reward || 0),
        xp: Number(q.xp || 0),
        description: q.description || ""
    };
}

function token(user) {
    return jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: "30d" }
    );
}

async function getUser(id) {
    const q = await pool.query(
        "SELECT * FROM users WHERE id=$1",
        [id]
    );

    return q.rows[0] || null;
}

function broadcast() {
    io.emit("leaderboard:update");
    io.emit("ranks:update");
    io.emit("quests:update");
}

/* =========================
   DATABASE
========================= */

async function initDatabase() {

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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            title TEXT NOT NULL,
            price BIGINT NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#a855f7',
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

    for (const r of DEFAULT_RANKS) {
        await pool.query(`
            INSERT INTO ranks
            (id,name,title,price,color,icon)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT(id) DO NOTHING
        `, [
            r.id,
            r.name,
            r.title,
            r.price,
            r.color,
            r.icon
        ]);
    }

    for (const q of DEFAULT_QUESTS) {
        await pool.query(`
            INSERT INTO quests
            (id,title,reward,xp,description)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT(id) DO NOTHING
        `, [
            q.id,
            q.title,
            q.reward,
            q.xp,
            q.description
        ]);
    }

    console.log("ASTRO DATABASE READY");
}

/* =========================
   AUTH
========================= */

async function auth(req, res, next) {

    try {

        const header =
            req.headers.authorization || "";

        const t =
            header.startsWith("Bearer ")
                ? header.substring(7)
                : "";

        if (!t) {
            return res.status(401).json({
                error: "Требуется вход."
            });
        }

        const data = jwt.verify(t, JWT_SECRET);
        const user = await getUser(data.id);

        if (!user) {
            return res.status(401).json({
                error: "Пользователь не найден."
            });
        }

        req.user = user;

        next();

    } catch (e) {

        return res.status(401).json({
            error: "Сессия недействительна."
        });
    }
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            ok: true,
            database: true
        });

    } catch (e) {

        res.status(500).json({
            ok: false,
            database: false,
            error: e.message
        });
    }
});

/* =========================
   REGISTER
========================= */

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
            return res.status(400).json({
                error: "Введите корректный email."
            });
        }

        if (!/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(username)) {
            return res.status(400).json({
                error: "Никнейм: 3–20 символов."
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 8 символов."
            });
        }

        const exists = await pool.query(`
            SELECT 1
            FROM users
            WHERE lower(email)=lower($1)
               OR lower(username)=lower($2)
        `, [
            email,
            username
        ]);

        if (exists.rowCount) {
            return res.status(409).json({
                error: "Email или никнейм уже занят."
            });
        }

        const hash =
            await bcrypt.hash(password, 12);

        const q = await pool.query(`
            INSERT INTO users
            (id,email,username,password_hash)
            VALUES
            (gen_random_uuid(),$1,$2,$3)
            RETURNING *
        `, [
            email,
            username,
            hash
        ]);

        const user = q.rows[0];

        broadcast();

        res.json({
            token: token(user),
            user: userJSON(user)
        });

    } catch (e) {

        console.error("REGISTER:", e);

        res.status(500).json({
            error: "Не удалось создать аккаунт."
        });
    }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {

    try {

        const email =
            String(req.body?.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body?.password || "");

        const q = await pool.query(`
            SELECT *
            FROM users
            WHERE lower(email)=lower($1)
        `, [email]);

        const user = q.rows[0];

        if (
            !user ||
            !(await bcrypt.compare(
                password,
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
            await getUser(user.id);

        res.json({
            token: token(fresh),
            user: userJSON(fresh)
        });

    } catch (e) {

        console.error("LOGIN:", e);

        res.status(500).json({
            error: "Ошибка входа."
        });
    }
});

/* =========================
   PROFILE
========================= */

app.get("/api/me", auth, (req, res) => {

    res.json({
        user: userJSON(req.user)
    });
});

app.put("/api/profile", auth, async (req, res) => {

    try {

        const username =
            String(req.body?.username || "").trim();

        if (!/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(username)) {
            return res.status(400).json({
                error: "Никнейм: 3–20 символов."
            });
        }

        const duplicate =
            await pool.query(`
                SELECT 1
                FROM users
                WHERE lower(username)=lower($1)
                AND id<>$2
            `, [
                username,
                req.user.id
            ]);

        if (duplicate.rowCount) {
            return res.status(409).json({
                error: "Такой никнейм уже занят."
            });
        }

        const q = await pool.query(`
            UPDATE users
            SET username=$1
            WHERE id=$2
            RETURNING *
        `, [
            username,
            req.user.id
        ]);

        broadcast();

        res.json({
            user: userJSON(q.rows[0])
        });

    } catch (e) {

        res.status(500).json({
            error: "Не удалось сохранить профиль."
        });
    }
});

/* =========================
   RANKS
========================= */

app.get("/api/ranks", async (req, res) => {

    try {

        const q = await pool.query(`
            SELECT *
            FROM ranks
            ORDER BY created_at ASC
        `);

        res.json({
            ranks: q.rows.map(rankJSON)
        });

    } catch (e) {

        console.error("RANKS:", e);

        res.status(500).json({
            error: "Ошибка загрузки рангов."
        });
    }
});

/* =========================
   BUY RANK
========================= */

app.post("/api/ranks/:id/buy", auth, async (req, res) => {

    const client =
        await pool.connect();

    try {

        await client.query("BEGIN");

        const rankQ =
            await client.query(`
                SELECT *
                FROM ranks
                WHERE id=$1
            `, [req.params.id]);

        const rank = rankQ.rows[0];

        if (!rank) {
            throw new Error("Ранг не найден.");
        }

        const userQ =
            await client.query(`
                SELECT *
                FROM users
                WHERE id=$1
                FOR UPDATE
            `, [req.user.id]);

        const user = userQ.rows[0];

        const owned =
            Array.isArray(user.owned_ranks)
                ? [...user.owned_ranks]
                : [];

        if (owned.includes(rank.id)) {
            throw new Error(
                "Этот ранг уже куплен."
            );
        }

        if (
            Number(user.balance) <
            Number(rank.price)
        ) {
            throw new Error(
                `Не хватает ${
                    (
                        Number(rank.price) -
                        Number(user.balance)
                    ).toLocaleString("ru-RU")
                } ₽`
            );
        }

        owned.push(rank.id);

        const history = [
            ...(Array.isArray(user.history)
                ? user.history
                : []),
            {
                title: `Покупка ранга · ${rank.name}`,
                amount: -Number(rank.price),
                createdAt: new Date().toISOString()
            }
        ].slice(-50);

        const update =
            await client.query(`
                UPDATE users
                SET
                    balance=balance-$1,
                    owned_ranks=$2,
                    history=$3
                WHERE id=$4
                RETURNING *
            `, [
                rank.price,
                JSON.stringify(owned),
                JSON.stringify(history),
                user.id
            ]);

        await client.query("COMMIT");

        broadcast();

        res.json({
            user: userJSON(update.rows[0]),
            rank: rankJSON(rank)
        });

    } catch (e) {

        await client.query("ROLLBACK");

        res.status(400).json({
            error: e.message
        });

    } finally {

        client.release();
    }
});

/* =========================
   QUESTS
========================= */

app.get("/api/quests", async (req, res) => {

    try {

        const q = await pool.query(`
            SELECT *
            FROM quests
            ORDER BY created_at ASC
        `);

        res.json({
            quests: q.rows.map(questJSON)
        });

    } catch (e) {

        console.error("QUESTS:", e);

        res.status(500).json({
            error: "Ошибка загрузки квестов."
        });
    }
});

/* =========================
   CLAIM QUEST
========================= */

app.post("/api/quests/:id/claim", auth, async (req, res) => {

    const client =
        await pool.connect();

    try {

        await client.query("BEGIN");

        const questQ =
            await client.query(`
                SELECT *
                FROM quests
                WHERE id=$1
            `, [req.params.id]);

        const quest = questQ.rows[0];

        if (!quest) {
            throw new Error(
                "Квест не найден."
            );
        }

        const userQ =
            await client.query(`
                SELECT *
                FROM users
                WHERE id=$1
                FOR UPDATE
            `, [req.user.id]);

        const user = userQ.rows[0];

        const claimed =
            user.claimed_quests || {};

        if (claimed[quest.id]) {
            throw new Error(
                "Этот квест уже получен."
            );
        }

        claimed[quest.id] = true;

        const history = [
            ...(Array.isArray(user.history)
                ? user.history
                : []),
            {
                title: `Квест · ${quest.title}`,
                amount: Number(quest.reward),
                createdAt: new Date().toISOString()
            }
        ].slice(-50);

        const update =
            await client.query(`
                UPDATE users
                SET
                    balance=balance+$1,
                    xp=xp+$2,
                    claimed_quests=$3,
                    history=$4
                WHERE id=$5
                RETURNING *
            `, [
                quest.reward,
                quest.xp,
                JSON.stringify(claimed),
                JSON.stringify(history),
                user.id
            ]);

        await client.query("COMMIT");

        broadcast();

        res.json({
            user: userJSON(update.rows[0]),
            reward: Number(quest.reward),
            xp: Number(quest.xp)
        });

    } catch (e) {

        await client.query("ROLLBACK");

        res.status(400).json({
            error: e.message
        });

    } finally {

        client.release();
    }
});

/* =========================
   LEADERBOARD
========================= */

app.get("/api/leaderboard", async (req, res) => {

    try {

        const q = await pool.query(`
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
                wins DESC,
                username ASC
        `);

        res.json({
            players: q.rows.map(u => ({
                id: u.id,
                username: u.username,
                elo: Number(u.elo || 0),
                xp: Number(u.xp || 0),
                wins: Number(u.wins || 0),
                ownedRanks:
                    Array.isArray(u.owned_ranks)
                        ? u.owned_ranks
                        : []
            }))
        });

    } catch (e) {

        console.error("LEADERBOARD:", e);

        res.status(500).json({
            error: "Ошибка рейтинга."
        });
    }
});

/* =========================
   ADMIN USERS
========================= */

app.get("/api/admin/users", async (req, res) => {

    try {

        const search =
            String(req.query.search || "").trim();

        let q;

        if (search) {

            q = await pool.query(`
                SELECT *
                FROM users
                WHERE username ILIKE $1
                   OR email ILIKE $1
                ORDER BY elo DESC
            `, [`%${search}%`]);

        } else {

            q = await pool.query(`
                SELECT *
                FROM users
                ORDER BY elo DESC
            `);
        }

        res.json({
            users: q.rows.map(userJSON)
        });

    } catch (e) {

        console.error("ADMIN USERS:", e);

        res.status(500).json({
            error: "Не удалось загрузить пользователей."
        });
    }
});

/* =========================
   ADMIN EDIT PLAYER
========================= */

app.put("/api/admin/users/:id", async (req, res) => {

    try {

        const fields = [
            "balance",
            "xp",
            "elo",
            "wins"
        ];

        const set = [];
        const values = [];

        for (const field of fields) {

            if (req.body?.[field] !== undefined) {

                const value =
                    num(req.body[field], -1);

                if (value < 0) {
                    return res.status(400).json({
                        error:
                            `Неверное значение ${field}.`
                    });
                }

                set.push(
                    `${field}=$${values.length + 1}`
                );

                values.push(value);
            }
        }

        if (!set.length) {
            return res.status(400).json({
                error: "Нет данных для изменения."
            });
        }

        values.push(req.params.id);

        const q = await pool.query(`
            UPDATE users
            SET ${set.join(",")}
            WHERE id=$${values.length}
            RETURNING *
        `, values);

        if (!q.rows[0]) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        broadcast();

        res.json({
            user: userJSON(q.rows[0])
        });

    } catch (e) {

        console.error("ADMIN PLAYER:", e);

        res.status(500).json({
            error: "Не удалось изменить игрока."
        });
    }
});

/* =========================
   ADMIN RANK LIST
========================= */

app.get("/api/admin/ranks", async (req, res) => {

    try {

        const q = await pool.query(`
            SELECT *
            FROM ranks
            ORDER BY created_at ASC
        `);

        res.json({
            ranks: q.rows.map(rankJSON)
        });

    } catch (e) {

        res.status(500).json({
            error: "Не удалось загрузить ранги."
        });
    }
});

/* =========================
   ADMIN CREATE RANK
========================= */

app.post("/api/admin/ranks", async (req, res) => {

    try {

        const id =
            cleanId(
                req.body?.rankId ||
                req.body?.id
            );

        const name =
            String(
                req.body?.name || ""
            ).trim();

        const title =
            String(
                req.body?.title || ""
            ).trim();

        const price =
            Math.max(
                0,
                num(req.body?.price)
            );

        const color =
            String(
                req.body?.color ||
                "#a855f7"
            ).trim();

        const icon =
            String(
                req.body?.icon ||
                "◆"
            ).trim();

        if (!id || !name || !title) {
            return res.status(400).json({
                error:
                    "Нужны ID, название и титул."
            });
        }

        const q = await pool.query(`
            INSERT INTO ranks
            (id,name,title,price,color,icon)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *
        `, [
            id,
            name,
            title,
            price,
            color,
            icon
        ]);

        broadcast();

        res.json({
            rank: rankJSON(q.rows[0])
        });

    } catch (e) {

        console.error("CREATE RANK:", e);

        res.status(400).json({
            error:
                "Не удалось создать ранг. Возможно, такой ID уже существует."
        });
    }
});

/* =========================
   ADMIN DELETE RANK
========================= */

app.delete("/api/admin/ranks/:id", async (req, res) => {

    const client =
        await pool.connect();

    try {

        await client.query("BEGIN");

        await client.query(`
            DELETE FROM ranks
            WHERE id=$1
        `, [req.params.id]);

        const users =
            await client.query(`
                SELECT id,owned_ranks
                FROM users
            `);

        for (const user of users.rows) {

            const owned =
                Array.isArray(user.owned_ranks)
                    ? user.owned_ranks.filter(
                        x => x !== req.params.id
                    )
                    : [];

            await client.query(`
                UPDATE users
                SET owned_ranks=$1
                WHERE id=$2
            `, [
                JSON.stringify(owned),
                user.id
            ]);
        }

        await client.query("COMMIT");

        broadcast();

        res.json({
            success: true
        });

    } catch (e) {

        await client.query("ROLLBACK");

        res.status(500).json({
            error: "Не удалось удалить ранг."
        });

    } finally {

        client.release();
    }
});

/* =========================
   ADMIN GIVE RANK
========================= */

app.post(
    "/api/admin/users/:id/ranks/:rankId",
    async (req, res) => {

        try {

            const user =
                await getUser(req.params.id);

            const rank =
                await pool.query(`
                    SELECT *
                    FROM ranks
                    WHERE id=$1
                `, [req.params.rankId]);

            if (!user || !rank.rows[0]) {
                return res.status(404).json({
                    error:
                        "Игрок или ранг не найден."
                });
            }

            const owned =
                Array.isArray(user.owned_ranks)
                    ? [...user.owned_ranks]
                    : [];

            if (!owned.includes(req.params.rankId)) {
                owned.push(req.params.rankId);
            }

            const q = await pool.query(`
                UPDATE users
                SET owned_ranks=$1
                WHERE id=$2
                RETURNING *
            `, [
                JSON.stringify(owned),
                user.id
            ]);

            broadcast();

            res.json({
                user: userJSON(q.rows[0])
            });

        } catch (e) {

            res.status(500).json({
                error: "Не удалось выдать ранг."
            });
        }
    }
);

/* =========================
   ADMIN REMOVE RANK
========================= */

app.delete(
    "/api/admin/users/:id/ranks/:rankId",
    async (req, res) => {

        try {

            const user =
                await getUser(req.params.id);

            if (!user) {
                return res.status(404).json({
                    error: "Игрок не найден."
                });
            }

            const owned =
                Array.isArray(user.owned_ranks)
                    ? user.owned_ranks.filter(
                        x => x !== req.params.rankId
                    )
                    : [];

            const q = await pool.query(`
                UPDATE users
                SET owned_ranks=$1
                WHERE id=$2
                RETURNING *
            `, [
                JSON.stringify(owned),
                user.id
            ]);

            broadcast();

            res.json({
                user: userJSON(q.rows[0])
            });

        } catch (e) {

            res.status(500).json({
                error: "Не удалось снять ранг."
            });
        }
    }
);

/* =========================
   ADMIN QUESTS
========================= */

app.get("/api/admin/quests", async (req, res) => {

    try {

        const q = await pool.query(`
            SELECT *
            FROM quests
            ORDER BY created_at ASC
        `);

        res.json({
            quests: q.rows.map(questJSON)
        });

    } catch (e) {

        res.status(500).json({
            error:
                "Не удалось загрузить квесты."
        });
    }
});

/* =========================
   ADMIN CREATE QUEST
========================= */

app.post("/api/admin/quests", async (req, res) => {

    try {

        const id =
            cleanId(
                req.body?.questId ||
                req.body?.id
            );

        const title =
            String(
                req.body?.title || ""
            ).trim();

        const description =
            String(
                req.body?.description || ""
            ).trim();

        const reward =
            Math.max(
                0,
                num(req.body?.reward)
            );

        const xp =
            Math.max(
                0,
                num(req.body?.xp)
            );

        if (!id || !title) {
            return res.status(400).json({
                error:
                    "Нужны ID и название квеста."
            });
        }

        const q = await pool.query(`
            INSERT INTO quests
            (id,title,reward,xp,description)
            VALUES ($1,$2,$3,$4,$5)
            RETURNING *
        `, [
            id,
            title,
            reward,
            xp,
            description
        ]);

        broadcast();

        res.json({
            quest: questJSON(q.rows[0])
        });

    } catch (e) {

        console.error("CREATE QUEST:", e);

        res.status(400).json({
            error:
                "Не удалось создать квест. Возможно, такой ID уже существует."
        });
    }
});

/* =========================
   ADMIN EDIT QUEST
========================= */

app.put("/api/admin/quests/:id", async (req, res) => {

    try {

        const title =
            String(
                req.body?.title || ""
            ).trim();

        const description =
            String(
                req.body?.description || ""
            ).trim();

        const reward =
            Math.max(
                0,
                num(req.body?.reward)
            );

        const xp =
            Math.max(
                0,
                num(req.body?.xp)
            );

        const q = await pool.query(`
            UPDATE quests
            SET
                title=$1,
                reward=$2,
                xp=$3,
                description=$4
            WHERE id=$5
            RETURNING *
        `, [
            title,
            reward,
            xp,
            description,
            req.params.id
        ]);

        if (!q.rows[0]) {
            return res.status(404).json({
                error: "Квест не найден."
            });
        }

        broadcast();

        res.json({
            quest: questJSON(q.rows[0])
        });

    } catch (e) {

        res.status(500).json({
            error:
                "Не удалось изменить квест."
        });
    }
});

/* =========================
   ADMIN DELETE QUEST
========================= */

app.delete("/api/admin/quests/:id", async (req, res) => {

    try {

        await pool.query(`
            DELETE FROM quests
            WHERE id=$1
        `, [req.params.id]);

        await pool.query(`
            UPDATE users
            SET claimed_quests =
                COALESCE(
                    claimed_quests - $1,
                    '{}'::jsonb
                )
        `, [req.params.id]);

        broadcast();

        res.json({
            success: true
        });

    } catch (e) {

        res.status(500).json({
            error:
                "Не удалось удалить квест."
        });
    }
});

/* =========================
   FRONTEND
========================= */

app.use((req, res, next) => {

    if (req.method !== "GET") {
        return next();
    }

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );
});

/* =========================
   ERROR
========================= */

app.use((err, req, res, next) => {

    console.error(
        "SERVER ERROR:",
        err
    );

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error:
            "Внутренняя ошибка сервера."
    });
});

/* =========================
   START
========================= */

async function start() {

    try {

        await initDatabase();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log(
                    `ASTRO ONLINE запущен на порту ${PORT}`
                );
            }
        );

    } catch (e) {

        console.error(
            "ОШИБКА ЗАПУСКА:",
            e
        );

        process.exit(1);
    }
}

process.on("SIGINT", async () => {
    await pool.end();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
});

start();
