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
const JWT_SECRET = process.env.JWT_SECRET || "astro-secret-change-me";

if (!DATABASE_URL) {
    console.error("DATABASE_URL не задан.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_EMAIL = "admin@astro-online.ru";
const ADMIN_PASSWORD = "astro123456";

function publicUser(u) {
    return {
        id: u.id,
        email: u.email,
        username: u.username,
        balance: Number(u.balance || 0),
        xp: Number(u.xp || 0),
        elo: Number(u.elo || 1000),
        wins: Number(u.wins || 0),
        isAdmin: Boolean(u.is_admin),
        ownedRanks: u.owned_ranks || []
    };
}

function makeToken(user) {
    return jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: "30d" }
    );
}

async function auth(req, res, next) {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Требуется вход."
            });
        }

        const token = header.slice(7);
        const payload = jwt.verify(token, JWT_SECRET);

        const result = await pool.query(
            "SELECT * FROM users WHERE id=$1",
            [payload.id]
        );

        if (!result.rows[0]) {
            return res.status(401).json({
                error: "Пользователь не найден."
            });
        }

        req.user = result.rows[0];
        next();

    } catch (err) {
        return res.status(401).json({
            error: "Сессия недействительна."
        });
    }
}

async function adminAuth(req, res, next) {
    await auth(req, res, async () => {

        if (!req.user.is_admin) {
            return res.status(403).json({
                error: "Доступ только для администратора."
            });
        }

        next();
    });
}

function broadcast() {
    io.emit("leaderboard:update");
    io.emit("ranks:update");
    io.emit("quests:update");
}

async function initDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users(
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT UNIQUE NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance BIGINT NOT NULL DEFAULT 1000,
            xp BIGINT NOT NULL DEFAULT 0,
            elo BIGINT NOT NULL DEFAULT 1000,
            wins BIGINT NOT NULL DEFAULT 0,
            owned_ranks JSONB NOT NULL DEFAULT '[]',
            is_admin BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS owned_ranks JSONB NOT NULL DEFAULT '[]'
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks(
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            rank_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            title TEXT NOT NULL,
            price BIGINT NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#a855f7',
            icon TEXT NOT NULL DEFAULT '★',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quests(
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            quest_id TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            reward BIGINT NOT NULL DEFAULT 0,
            xp BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    const existingAdmin = await pool.query(
        "SELECT id FROM users WHERE lower(email)=lower($1)",
        [ADMIN_EMAIL]
    );

    if (!existingAdmin.rows[0]) {

        await pool.query(`
            INSERT INTO users(
                email,
                username,
                password_hash,
                is_admin,
                balance,
                elo
            )
            VALUES($1,$2,$3,true,999999999,999999)
        `, [
            ADMIN_EMAIL,
            "ASTRO_ADMIN",
            adminHash
        ]);

        console.log("Администратор создан:");
        console.log(ADMIN_EMAIL);
        console.log(ADMIN_PASSWORD);

    } else {

        await pool.query(`
            UPDATE users
            SET is_admin=true
            WHERE lower(email)=lower($1)
        `, [ADMIN_EMAIL]);

        console.log("Администратор найден.");
    }

    const rankCount = await pool.query(
        "SELECT COUNT(*) FROM ranks"
    );

    if (Number(rankCount.rows[0].count) === 0) {

        const defaultRanks = [
            ["bronze", "BRONZE", "Бронзовый", 5000, "#cd7f32", "◆"],
            ["silver", "SILVER", "Серебряный", 15000, "#b9c3d0", "◇"],
            ["gold", "GOLD", "Золотой", 35000, "#ffd45a", "✦"],
            ["diamond", "DIAMOND", "Алмазный", 75000, "#6ee7ff", "✧"],
            ["master", "MASTER", "Мастер", 150000, "#c084fc", "✹"],
            ["astro", "ASTRO", "ASTRO ELITE", 300000, "#ff6bd6", "★"]
        ];

        for (const r of defaultRanks) {
            await pool.query(`
                INSERT INTO ranks(
                    rank_id,name,title,price,color,icon
                )
                VALUES($1,$2,$3,$4,$5,$6)
                ON CONFLICT(rank_id) DO NOTHING
            `, r);
        }
    }

    const questCount = await pool.query(
        "SELECT COUNT(*) FROM quests"
    );

    if (Number(questCount.rows[0].count) === 0) {

        const defaultQuests = [
            [
                "daily-login",
                "Войти в систему",
                "Открой профиль и забери ежедневную награду.",
                50,
                25
            ],
            [
                "daily-explore",
                "Исследователь",
                "Посети разделы ASTRO.",
                100,
                50
            ],
            [
                "daily-elite",
                "Elite Protocol",
                "Выполни особое задание сезона.",
                250,
                100
            ]
        ];

        for (const q of defaultQuests) {
            await pool.query(`
                INSERT INTO quests(
                    quest_id,title,description,reward,xp
                )
                VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(quest_id) DO NOTHING
            `, q);
        }
    }

    console.log("ASTRO DATABASE READY");
}

/* =========================
   AUTH
========================= */

app.post("/api/register", async (req, res) => {

    try {

        const username = String(req.body?.username || "").trim();
        const email = String(req.body?.email || "")
            .trim()
            .toLowerCase();

        const password = String(req.body?.password || "");

        if (!/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({
                error: "Введите корректный email."
            });
        }

        if (!/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(username)) {
            return res.status(400).json({
                error: "Никнейм должен содержать 3–20 символов."
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 8 символов."
            });
        }

        const exists = await pool.query(`
            SELECT id
            FROM users
            WHERE lower(email)=lower($1)
               OR lower(username)=lower($2)
        `, [email, username]);

        if (exists.rows[0]) {
            return res.status(409).json({
                error: "Email или никнейм уже занят."
            });
        }

        const hash = await bcrypt.hash(password, 12);

        const result = await pool.query(`
            INSERT INTO users(
                email,
                username,
                password_hash
            )
            VALUES($1,$2,$3)
            RETURNING *
        `, [
            email,
            username,
            hash
        ]);

        const user = result.rows[0];

        broadcast();

        res.json({
            token: makeToken(user),
            user: publicUser(user)
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка регистрации."
        });
    }
});

app.post("/api/login", async (req, res) => {

    try {

        const email = String(req.body?.email || "")
            .trim()
            .toLowerCase();

        const password = String(req.body?.password || "");

        const result = await pool.query(
            "SELECT * FROM users WHERE lower(email)=lower($1)",
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        const correct = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!correct) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        await pool.query(
            "UPDATE users SET last_login_at=now() WHERE id=$1",
            [user.id]
        );

        const fresh = (
            await pool.query(
                "SELECT * FROM users WHERE id=$1",
                [user.id]
            )
        ).rows[0];

        res.json({
            token: makeToken(fresh),
            user: publicUser(fresh)
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка входа."
        });
    }
});

app.get("/api/me", auth, (req, res) => {
    res.json({
        user: publicUser(req.user)
    });
});

/* =========================
   RANKS
========================= */

app.get("/api/ranks", async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                id,
                rank_id,
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
                id: r.id,
                rankId: r.rank_id,
                name: r.name,
                title: r.title,
                price: Number(r.price),
                color: r.color,
                icon: r.icon
            }))
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка загрузки рангов."
        });
    }
});

app.post("/api/ranks/:id/buy", auth, async (req, res) => {

    const client = await pool.connect();

    try {

        const rankResult = await client.query(
            "SELECT * FROM ranks WHERE rank_id=$1",
            [req.params.id]
        );

        const rank = rankResult.rows[0];

        if (!rank) {
            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        await client.query("BEGIN");

        const userResult = await client.query(
            "SELECT * FROM users WHERE id=$1 FOR UPDATE",
            [req.user.id]
        );

        const user = userResult.rows[0];

        const owned = Array.isArray(user.owned_ranks)
            ? user.owned_ranks
            : [];

        if (owned.includes(rank.rank_id)) {
            throw new Error("Этот ранг уже куплен.");
        }

        if (Number(user.balance) < Number(rank.price)) {
            throw new Error("Недостаточно средств.");
        }

        owned.push(rank.rank_id);

        const updated = await client.query(`
            UPDATE users
            SET
                balance=balance-$1,
                owned_ranks=$2
            WHERE id=$3
            RETURNING *
        `, [
            rank.price,
            JSON.stringify(owned),
            user.id
        ]);

        await client.query("COMMIT");

        broadcast();

        res.json({
            user: publicUser(updated.rows[0]),
            rank: {
                rankId: rank.rank_id,
                name: rank.name
            }
        });

    } catch (err) {

        await client.query("ROLLBACK");

        res.status(400).json({
            error: err.message
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

        const result = await pool.query(`
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
                xp: Number(q.xp)
            }))
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка загрузки квестов."
        });
    }
});

app.post("/api/quests/:id/claim", auth, async (req, res) => {

    const client = await pool.connect();

    try {

        const questResult = await client.query(
            "SELECT * FROM quests WHERE quest_id=$1",
            [req.params.id]
        );

        const quest = questResult.rows[0];

        if (!quest) {
            return res.status(404).json({
                error: "Квест не найден."
            });
        }

        await client.query("BEGIN");

        const userResult = await client.query(
            "SELECT * FROM users WHERE id=$1 FOR UPDATE",
            [req.user.id]
        );

        const user = userResult.rows[0];

        const key = `quest_${quest.quest_id}`;

        const claimed = user.claimed_quests || {};

        if (claimed[key]) {
            throw new Error("Этот квест уже получен.");
        }

        claimed[key] = true;

        const updated = await client.query(`
            UPDATE users
            SET
                balance=balance+$1,
                xp=xp+$2,
                claimed_quests=$3
            WHERE id=$4
            RETURNING *
        `, [
            quest.reward,
            quest.xp,
            JSON.stringify(claimed),
            user.id
        ]);

        await client.query("COMMIT");

        broadcast();

        res.json({
            user: publicUser(updated.rows[0]),
            reward: Number(quest.reward),
            xp: Number(quest.xp)
        });

    } catch (err) {

        await client.query("ROLLBACK");

        res.status(400).json({
            error: err.message
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

        const result = await pool.query(`
            SELECT
                id,
                username,
                elo,
                xp,
                wins,
                owned_ranks
            FROM users
            ORDER BY elo DESC, xp DESC, wins DESC
        `);

        res.json({
            players: result.rows.map(u => ({
                id: u.id,
                username: u.username,
                elo: Number(u.elo),
                xp: Number(u.xp),
                wins: Number(u.wins),
                ownedRanks: u.owned_ranks || []
            }))
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка рейтинга."
        });
    }
});

/* =========================
   ADMIN USERS
========================= */

app.get("/api/admin/users", adminAuth, async (req, res) => {

    try {

        const search = String(req.query.search || "").trim();

        let result;

        if (search) {

            result = await pool.query(`
                SELECT
                    id,
                    email,
                    username,
                    balance,
                    elo,
                    xp,
                    wins,
                    owned_ranks,
                    is_admin
                FROM users
                WHERE username ILIKE $1
                   OR email ILIKE $1
                ORDER BY elo DESC
            `, [`%${search}%`]);

        } else {

            result = await pool.query(`
                SELECT
                    id,
                    email,
                    username,
                    balance,
                    elo,
                    xp,
                    wins,
                    owned_ranks,
                    is_admin
                FROM users
                ORDER BY elo DESC
            `);
        }

        res.json({
            users: result.rows.map(u => ({
                id: u.id,
                email: u.email,
                username: u.username,
                balance: Number(u.balance),
                elo: Number(u.elo),
                xp: Number(u.xp),
                wins: Number(u.wins),
                ownedRanks: u.owned_ranks || [],
                isAdmin: Boolean(u.is_admin)
            }))
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка загрузки игроков."
        });
    }
});

app.put("/api/admin/users/:id", adminAuth, async (req, res) => {

    try {

        const elo = Number(req.body?.elo);
        const wins = Number(req.body?.wins);
        const balance = Number(req.body?.balance);
        const xp = req.body?.xp === undefined
            ? null
            : Number(req.body.xp);

        if (
            !Number.isFinite(elo) ||
            !Number.isFinite(wins) ||
            !Number.isFinite(balance)
        ) {
            return res.status(400).json({
                error: "Некорректные значения."
            });
        }

        let result;

        if (xp === null) {

            result = await pool.query(`
                UPDATE users
                SET
                    elo=$1,
                    wins=$2,
                    balance=$3
                WHERE id=$4
                RETURNING *
            `, [
                Math.max(0, Math.floor(elo)),
                Math.max(0, Math.floor(wins)),
                Math.max(0, Math.floor(balance)),
                req.params.id
            ]);

        } else {

            result = await pool.query(`
                UPDATE users
                SET
                    elo=$1,
                    wins=$2,
                    balance=$3,
                    xp=$4
                WHERE id=$5
                RETURNING *
            `, [
                Math.max(0, Math.floor(elo)),
                Math.max(0, Math.floor(wins)),
                Math.max(0, Math.floor(balance)),
                Math.max(0, Math.floor(xp)),
                req.params.id
            ]);
        }

        if (!result.rows[0]) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        broadcast();

        res.json({
            user: publicUser(result.rows[0])
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка изменения игрока."
        });
    }
});

/* =========================
   ADMIN RANKS
========================= */

app.get("/api/admin/ranks", adminAuth, async (req, res) => {

    const result = await pool.query(
        "SELECT * FROM ranks ORDER BY price ASC"
    );

    res.json({
        ranks: result.rows
    });
});

app.post("/api/admin/ranks", adminAuth, async (req, res) => {

    try {

        const rankId = String(req.body?.rankId || "").trim();
        const name = String(req.body?.name || "").trim();
        const title = String(req.body?.title || "").trim();
        const price = Number(req.body?.price || 0);
        const color = String(req.body?.color || "#a855f7");
        const icon = String(req.body?.icon || "★");

        if (!rankId || !name || !title) {
            return res.status(400).json({
                error: "Заполни все поля ранга."
            });
        }

        if (!/^[a-zA-Z0-9_-]{2,40}$/.test(rankId)) {
            return res.status(400).json({
                error: "ID ранга: только латиница, цифры, _ и -."
            });
        }

        if (!Number.isFinite(price) || price < 0) {
            return res.status(400).json({
                error: "Некорректная цена."
            });
        }

        const result = await pool.query(`
            INSERT INTO ranks(
                rank_id,
                name,
                title,
                price,
                color,
                icon
            )
            VALUES($1,$2,$3,$4,$5,$6)
            RETURNING *
        `, [
            rankId,
            name,
            title,
            Math.floor(price),
            color,
            icon
        ]);

        broadcast();

        res.json({
            rank: result.rows[0]
        });

    } catch (err) {

        if (err.code === "23505") {
            return res.status(409).json({
                error: "Такой ID ранга уже существует."
            });
        }

        console.error(err);

        res.status(500).json({
            error: "Ошибка создания ранга."
        });
    }
});

app.delete("/api/admin/ranks/:id", adminAuth, async (req, res) => {

    try {

        const result = await pool.query(
            "DELETE FROM ranks WHERE id=$1 RETURNING *",
            [req.params.id]
        );

        if (!result.rows[0]) {
            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        const rankId = result.rows[0].rank_id;

        await pool.query(`
            UPDATE users
            SET owned_ranks = (
                SELECT COALESCE(
                    jsonb_agg(value),
                    '[]'::jsonb
                )
                FROM jsonb_array_elements(owned_ranks) AS value
                WHERE value <> to_jsonb($1::text)
            )
        `, [rankId]);

        broadcast();

        res.json({
            success: true
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка удаления ранга."
        });
    }
});

/* ВЫДАТЬ РАНГ */

app.post("/api/admin/users/:userId/ranks/:rankId", adminAuth, async (req, res) => {

    try {

        const userResult = await pool.query(
            "SELECT * FROM users WHERE id=$1",
            [req.params.userId]
        );

        const rankResult = await pool.query(
            "SELECT * FROM ranks WHERE rank_id=$1",
            [req.params.rankId]
        );

        const user = userResult.rows[0];
        const rank = rankResult.rows[0];

        if (!user) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        if (!rank) {
            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        const owned = Array.isArray(user.owned_ranks)
            ? user.owned_ranks
            : [];

        if (!owned.includes(rank.rank_id)) {
            owned.push(rank.rank_id);
        }

        const result = await pool.query(`
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
            user: publicUser(result.rows[0])
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка выдачи ранга."
        });
    }
});

/* СНЯТЬ РАНГ */

app.delete("/api/admin/users/:userId/ranks/:rankId", adminAuth, async (req, res) => {

    try {

        const userResult = await pool.query(
            "SELECT * FROM users WHERE id=$1",
            [req.params.userId]
        );

        if (!userResult.rows[0]) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        const user = userResult.rows[0];

        const owned = Array.isArray(user.owned_ranks)
            ? user.owned_ranks
            : [];

        const newOwned = owned.filter(
            x => x !== req.params.rankId
        );

        const result = await pool.query(`
            UPDATE users
            SET owned_ranks=$1
            WHERE id=$2
            RETURNING *
        `, [
            JSON.stringify(newOwned),
            user.id
        ]);

        broadcast();

        res.json({
            user: publicUser(result.rows[0])
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка снятия ранга."
        });
    }
});

/* =========================
   ADMIN QUESTS
========================= */

app.get("/api/admin/quests", adminAuth, async (req, res) => {

    const result = await pool.query(
        "SELECT * FROM quests ORDER BY created_at ASC"
    );

    res.json({
        quests: result.rows
    });
});

app.post("/api/admin/quests", adminAuth, async (req, res) => {

    try {

        const questId = String(req.body?.questId || "").trim();
        const title = String(req.body?.title || "").trim();
        const description = String(
            req.body?.description || ""
        ).trim();

        const reward = Number(req.body?.reward || 0);
        const xp = Number(req.body?.xp || 0);

        if (!questId || !title) {
            return res.status(400).json({
                error: "Заполни ID и название квеста."
            });
        }

        if (!/^[a-zA-Z0-9_-]{2,40}$/.test(questId)) {
            return res.status(400).json({
                error: "ID квеста некорректный."
            });
        }

        if (
            !Number.isFinite(reward) ||
            !Number.isFinite(xp) ||
            reward < 0 ||
            xp < 0
        ) {
            return res.status(400).json({
                error: "Некорректная награда."
            });
        }

        const result = await pool.query(`
            INSERT INTO quests(
                quest_id,
                title,
                description,
                reward,
                xp
            )
            VALUES($1,$2,$3,$4,$5)
            RETURNING *
        `, [
            questId,
            title,
            description,
            Math.floor(reward),
            Math.floor(xp)
        ]);

        broadcast();

        res.json({
            quest: result.rows[0]
        });

    } catch (err) {

        if (err.code === "23505") {
            return res.status(409).json({
                error: "Такой ID квеста уже существует."
            });
        }

        console.error(err);

        res.status(500).json({
            error: "Ошибка создания квеста."
        });
    }
});

app.delete("/api/admin/quests/:id", adminAuth, async (req, res) => {

    try {

        const result = await pool.query(
            "DELETE FROM quests WHERE id=$1 RETURNING *",
            [req.params.id]
        );

        if (!result.rows[0]) {
            return res.status(404).json({
                error: "Квест не найден."
            });
        }

        broadcast();

        res.json({
            success: true
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Ошибка удаления квеста."
        });
    }
});

/* =========================
   ADMIN INFO
========================= */

app.get("/api/admin/check", adminAuth, (req, res) => {
    res.json({
        admin: true,
        user: publicUser(req.user)
    });
});

/* =========================
   SOCKET
========================= */

io.on("connection", socket => {
    console.log("Socket connected:", socket.id);
});

/* =========================
   FRONTEND FALLBACK
========================= */

app.get("*", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

/* =========================
   START
========================= */

initDatabase()
    .then(() => {

        server.listen(PORT, "0.0.0.0", () => {
            console.log(
                `ASTRO ONLINE listening on port ${PORT}`
            );
        });

    })
    .catch(err => {

        console.error("DATABASE START ERROR:");
        console.error(err);

        process.exit(1);
    });
