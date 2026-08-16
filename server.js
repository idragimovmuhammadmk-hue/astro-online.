const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "data.json");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* =========================================================
   DATABASE
========================================================= */

const DEFAULT_DB = {
    users: [],
    ranks: [
        {
            id: "bronze",
            rankId: "bronze",
            name: "BRONZE",
            title: "Бронзовый",
            price: 1000,
            color: "#cd7f32",
            icon: "🥉"
        },
        {
            id: "silver",
            rankId: "silver",
            name: "SILVER",
            title: "Серебряный",
            price: 5000,
            color: "#cbd5e1",
            icon: "🥈"
        },
        {
            id: "gold",
            rankId: "gold",
            name: "GOLD",
            title: "Золотой",
            price: 15000,
            color: "#ffd700",
            icon: "🥇"
        },
        {
            id: "diamond",
            rankId: "diamond",
            name: "DIAMOND",
            title: "Алмазный",
            price: 50000,
            color: "#67e8f9",
            icon: "💎"
        },
        {
            id: "master",
            rankId: "master",
            name: "MASTER",
            title: "Мастер",
            price: 100000,
            color: "#c084fc",
            icon: "👑"
        }
    ],
    quests: [
        {
            id: "first-win",
            questId: "first-win",
            title: "Первая победа",
            description: "Получи свою первую победу.",
            reward: 500,
            xp: 100
        },
        {
            id: "rich-player",
            questId: "rich-player",
            title: "Космический капитал",
            description: "Накопи 10 000 монет.",
            reward: 1500,
            xp: 250
        }
    ]
};

function createDefaultDB() {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(DEFAULT_DB, null, 2),
        "utf8"
    );

    return JSON.parse(JSON.stringify(DEFAULT_DB));
}

let db;

try {
    if (!fs.existsSync(DB_FILE)) {
        db = createDefaultDB();
    } else {
        db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

        if (!Array.isArray(db.users)) db.users = [];
        if (!Array.isArray(db.ranks)) db.ranks = [];
        if (!Array.isArray(db.quests)) db.quests = [];
    }
} catch (error) {
    console.error("Ошибка чтения базы:", error);
    db = createDefaultDB();
}

function saveDB() {
    try {
        const temp = DB_FILE + ".tmp";

        fs.writeFileSync(
            temp,
            JSON.stringify(db, null, 2),
            "utf8"
        );

        fs.renameSync(temp, DB_FILE);

        return true;
    } catch (error) {
        console.error("Ошибка сохранения базы:", error);
        return false;
    }
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

/* =========================================================
   HELPERS
========================================================= */

function clean(value, max = 200) {
    return String(value ?? "")
        .trim()
        .slice(0, max);
}

function normalizeEmail(email) {
    return clean(email, 200).toLowerCase();
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashPassword(password, salt) {
    return crypto
        .pbkdf2Sync(
            password,
            salt,
            120000,
            64,
            "sha512"
        )
        .toString("hex");
}

function makePassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    return {
        salt,
        hash: hashPassword(password, salt)
    };
}

function checkPassword(password, user) {
    if (!user.passwordHash || !user.passwordSalt) {
        return false;
    }

    const hash = hashPassword(
        password,
        user.passwordSalt
    );

    return crypto.timingSafeEqual(
        Buffer.from(hash),
        Buffer.from(user.passwordHash)
    );
}

function createId() {
    return crypto.randomUUID();
}

/* =========================================================
   SESSIONS
========================================================= */

const sessions = new Map();

function createSession(userId) {
    const token = crypto.randomBytes(48).toString("hex");

    sessions.set(token, {
        userId,
        createdAt: Date.now()
    });

    return token;
}

function getUserFromToken(token) {
    if (!token) return null;

    const session = sessions.get(token);

    if (!session) return null;

    const user = db.users.find(
        u => u.id === session.userId
    );

    return user || null;
}

function auth(req, res, next) {
    const header = req.headers.authorization || "";

    const token = header.startsWith("Bearer ")
        ? header.slice(7)
        : null;

    const user = getUserFromToken(token);

    if (!user) {
        return res.status(401).json({
            error: "Необходима авторизация."
        });
    }

    req.user = user;
    req.token = token;

    next();
}

function adminAuth(req, res, next) {
    auth(req, res, () => {
        if (!req.user.isAdmin) {
            return res.status(403).json({
                error: "Доступ только для администратора."
            });
        }

        next();
    });
}

/* =========================================================
   RANK SYSTEM
========================================================= */

function getRankByElo(elo) {
    const value = Number(elo) || 0;

    if (value >= 3000) {
        return {
            id: "grandmaster",
            rankId: "grandmaster",
            name: "GRANDMASTER",
            title: "Великий магистр",
            color: "#ff4fd8",
            icon: "🌌"
        };
    }

    if (value >= 2500) {
        return {
            id: "master",
            rankId: "master",
            name: "MASTER",
            title: "Мастер",
            color: "#c084fc",
            icon: "👑"
        };
    }

    if (value >= 2000) {
        return {
            id: "diamond",
            rankId: "diamond",
            name: "DIAMOND",
            title: "Алмазный",
            color: "#67e8f9",
            icon: "💎"
        };
    }

    if (value >= 1500) {
        return {
            id: "gold",
            rankId: "gold",
            name: "GOLD",
            title: "Золотой",
            color: "#ffd700",
            icon: "🥇"
        };
    }

    if (value >= 1000) {
        return {
            id: "silver",
            rankId: "silver",
            name: "SILVER",
            title: "Серебряный",
            color: "#cbd5e1",
            icon: "🥈"
        };
    }

    return {
        id: "bronze",
        rankId: "bronze",
        name: "BRONZE",
        title: "Бронзовый",
        color: "#cd7f32",
        icon: "🥉"
    };
}

/* =========================================================
   PUBLIC USER
========================================================= */

function publicUser(user) {
    const rank = getRankByElo(user.elo);

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: Number(user.balance) || 0,
        elo: Number(user.elo) || 0,
        xp: Number(user.xp) || 0,
        wins: Number(user.wins) || 0,
        ownedRanks: Array.isArray(user.ownedRanks)
            ? user.ownedRanks
            : [],
        completedQuests: Array.isArray(user.completedQuests)
            ? user.completedQuests
            : [],
        rank
    };
}

/* =========================================================
   BASIC
========================================================= */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        message: "ASTRO ONLINE SERVER OK",
        time: new Date().toISOString()
    });
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", (req, res) => {
    try {
        const username = clean(req.body.username, 30);
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || "");

        if (username.length < 3) {
            return res.status(400).json({
                error: "Никнейм должен содержать минимум 3 символа."
            });
        }

        if (!validEmail(email)) {
            return res.status(400).json({
                error: "Введите корректный email."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 6 символов."
            });
        }

        const emailExists = db.users.some(
            u => u.email === email
        );

        if (emailExists) {
            return res.status(409).json({
                error: "Этот email уже зарегистрирован."
            });
        }

        const usernameExists = db.users.some(
            u => u.username.toLowerCase() === username.toLowerCase()
        );

        if (usernameExists) {
            return res.status(409).json({
                error: "Этот никнейм уже занят."
            });
        }

        const passwordData = makePassword(password);

        const user = {
            id: createId(),
            username,
            email,

            passwordHash: passwordData.hash,
            passwordSalt: passwordData.salt,

            balance: 10000,
            elo: 1000,
            xp: 0,
            wins: 0,

            ownedRanks: [],
            completedQuests: [],

            isAdmin: db.users.length === 0,

            createdAt: new Date().toISOString()
        };

        db.users.push(user);

        if (!saveDB()) {
            return res.status(500).json({
                error: "Не удалось сохранить аккаунт."
            });
        }

        const token = createSession(user.id);

        res.json({
            success: true,
            token,
            user: publicUser(user)
        });

        io.emit("leaderboard:update");

    } catch (error) {
        console.error("REGISTER:", error);

        res.status(500).json({
            error: "Ошибка регистрации."
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || "");

        if (!email || !password) {
            return res.status(400).json({
                error: "Введите email и пароль."
            });
        }

        const user = db.users.find(
            u => u.email === email
        );

        if (!user) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        if (!checkPassword(password, user)) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        const token = createSession(user.id);

        res.json({
            success: true,
            token,
            user: publicUser(user)
        });

    } catch (error) {
        console.error("LOGIN:", error);

        res.status(500).json({
            error: "Ошибка авторизации."
        });
    }
});

/* =========================================================
   LOGOUT
========================================================= */

app.post("/api/logout", auth, (req, res) => {
    sessions.delete(req.token);

    res.json({
        success: true
    });
});

/* =========================================================
   ME
========================================================= */

app.get("/api/me", auth, (req, res) => {
    res.json({
        success: true,
        user: publicUser(req.user)
    });
});

/* =========================================================
   RANKS
========================================================= */

app.get("/api/ranks", (req, res) => {
    res.json({
        success: true,
        ranks: db.ranks
    });
});

/* =========================================================
   BUY RANK
========================================================= */

app.post("/api/ranks/:rankId/buy", auth, (req, res) => {
    try {
        const rankId = clean(req.params.rankId, 100);

        const rank = db.ranks.find(
            r => r.id === rankId || r.rankId === rankId
        );

        if (!rank) {
            return res.status(404).json({
                error: "Ранг не найден."
            });
        }

        if (!Array.isArray(req.user.ownedRanks)) {
            req.user.ownedRanks = [];
        }

        if (req.user.ownedRanks.includes(rank.id)) {
            return res.status(400).json({
                error: "Этот ранг уже куплен."
            });
        }

        const price = Number(rank.price) || 0;

        if (req.user.balance < price) {
            return res.status(400).json({
                error:
                    "Недостаточно денег. Нужно " +
                    price.toLocaleString() +
                    " ₽."
            });
        }

        req.user.balance -= price;
        req.user.ownedRanks.push(rank.id);

        if (!saveDB()) {
            return res.status(500).json({
                error: "Не удалось сохранить покупку."
            });
        }

        io.emit("leaderboard:update");

        res.json({
            success: true,
            message: "Ранг куплен.",
            user: publicUser(req.user)
        });

    } catch (error) {
        console.error("BUY RANK:", error);

        res.status(500).json({
            error: "Ошибка покупки ранга."
        });
    }
});

/* =========================================================
   QUESTS
========================================================= */

app.get("/api/quests", (req, res) => {
    res.json({
        success: true,
        quests: db.quests
    });
});

/* =========================================================
   CLAIM QUEST
========================================================= */

app.post("/api/quests/:questId/claim", auth, (req, res) => {
    try {
        const questId = clean(req.params.questId, 100);

        const quest = db.quests.find(
            q => q.id === questId || q.questId === questId
        );

        if (!quest) {
            return res.status(404).json({
                error: "Квест не найден."
            });
        }

        if (!Array.isArray(req.user.completedQuests)) {
            req.user.completedQuests = [];
        }

        if (req.user.completedQuests.includes(quest.id)) {
            return res.status(400).json({
                error: "Этот квест уже выполнен."
            });
        }

        const reward = Number(quest.reward) || 0;
        const xp = Number(quest.xp) || 0;

        req.user.balance += reward;
        req.user.xp += xp;

        req.user.completedQuests.push(quest.id);

        if (!saveDB()) {
            return res.status(500).json({
                error: "Не удалось сохранить квест."
            });
        }

        res.json({
            success: true,
            reward,
            xp,
            user: publicUser(req.user)
        });

        io.emit("leaderboard:update");

    } catch (error) {
        console.error("QUEST:", error);

        res.status(500).json({
            error: "Ошибка выполнения квеста."
        });
    }
});

/* =========================================================
   LEADERBOARD
========================================================= */

app.get("/api/leaderboard", (req, res) => {
    const players = db.users
        .map(publicUser)
        .sort((a, b) => {
            if (b.elo !== a.elo) {
                return b.elo - a.elo;
            }

            if (b.xp !== a.xp) {
                return b.xp - a.xp;
            }

            return b.wins - a.wins;
        });

    res.json({
        success: true,
        players
    });
});

/* =========================================================
   ADMIN USERS
========================================================= */

app.get("/api/admin/users", adminAuth, (req, res) => {
    const search = clean(req.query.search, 100).toLowerCase();

    let users = db.users;

    if (search) {
        users = users.filter(u =>
            u.username.toLowerCase().includes(search) ||
            u.email.toLowerCase().includes(search)
        );
    }

    res.json({
        success: true,
        users: users.map(publicUser)
    });
});

/* =========================================================
   ADMIN UPDATE USER
========================================================= */

app.put("/api/admin/users/:id", adminAuth, (req, res) => {
    try {
        const user = db.users.find(
            u => u.id === req.params.id
        );

        if (!user) {
            return res.status(404).json({
                error: "Игрок не найден."
            });
        }

        if (req.body.elo !== undefined) {
            user.elo = Math.max(
                0,
                Math.floor(Number(req.body.elo) || 0)
            );
        }

        if (req.body.xp !== undefined) {
            user.xp = Math.max(
                0,
                Math.floor(Number(req.body.xp) || 0)
            );
        }

        if (req.body.wins !== undefined) {
            user.wins = Math.max(
                0,
                Math.floor(Number(req.body.wins) || 0)
            );
        }

        if (req.body.balance !== undefined) {
            user.balance = Math.max(
                0,
                Math.floor(Number(req.body.balance) || 0)
            );
        }

        if (!saveDB()) {
            return res.status(500).json({
                error: "Не удалось сохранить игрока."
            });
        }

        io.emit("leaderboard:update");

        res.json({
            success: true,
            user: publicUser(user)
        });

    } catch (error) {
        console.error("ADMIN USER:", error);

        res.status(500).json({
            error: "Ошибка изменения игрока."
        });
    }
});

/* =========================================================
   ADMIN CREATE RANK
========================================================= */

app.post("/api/admin/ranks", adminAuth, (req, res) => {
    try {
        const rankId = clean(req.body.rankId, 50);
        const name = clean(req.body.name, 50);
        const title = clean(req.body.title, 100);
        const color = clean(req.body.color, 30);
        const icon = clean(req.body.icon, 10);

        const price = Math.max(
            0,
            Math.floor(Number(req.body.price) || 0)
        );

        if (!rankId || !name) {
            return res.status(400).json({
                error: "ID и название обязательны."
            });
        }

        const exists = db.ranks.some(
            r => r.id === rankId || r.rankId === rankId
        );

        if (exists) {
            return res.status(409).json({
                error: "Такой ранг уже существует."
            });
        }

        const rank = {
            id: rankId,
            rankId,
            name,
            title,
            price,
            color: color || "#9b7cff",
            icon: icon || "★"
        };

        db.ranks.push(rank);

        if (!saveDB()) {
            return res.status(500).json({
                error: "Не удалось сохранить ранг."
            });
        }

        io.emit("ranks:update");

        res.json({
            success: true,
            rank
        });

    } catch (error) {
        console.error("CREATE RANK:", error);

        res.status(500).json({
            error: "Ошибка создания ранга."
        });
    }
});

/* =========================================================
   ADMIN DELETE RANK
========================================================= */

app.delete("/api/admin/ranks/:id", adminAuth, (req, res) => {
    const index = db.ranks.findIndex(
        r => r.id === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({
            error: "Ранг не найден."
        });
    }

    const removed = db.ranks.splice(index, 1)[0];

    for (const user of db.users) {
        if (Array.isArray(user.ownedRanks)) {
            user.ownedRanks =
                user.ownedRanks.filter(
                    id => id !== removed.id
                );
        }
    }

    if (!saveDB()) {
        return res.status(500).json({
            error: "Не удалось удалить ранг."
        });
    }

    io.emit("ranks:update");

    res.json({
        success: true
    });
});

/* =========================================================
   ADMIN GET RANKS
========================================================= */

app.get("/api/admin/ranks", adminAuth, (req, res) => {
    res.json({
        success: true,
        ranks: db.ranks
    });
});

/* =========================================================
   ADMIN CREATE QUEST
========================================================= */

app.post("/api/admin/quests", adminAuth, (req, res) => {
    try {
        const questId = clean(req.body.questId, 50);
        const title = clean(req.body.title, 100);
        const description = clean(
            req.body.description,
            500
        );

        const reward = Math.max(
            0,
            Math.floor(Number(req.body.reward) || 0)
        );

        const xp = Math.max(
            0,
            Math.floor(Number(req.body.xp) || 0)
        );

        if (!questId || !title) {
            return res.status(400).json({
                error: "ID и название обязательны."
            });
        }

        const exists = db.quests.some(
            q => q.id === questId || q.questId === questId
        );

        if (exists) {
            return res.status(409).json({
                error: "Такой квест уже существует."
            });
        }

        const quest = {
            id: questId,
            questId,
            title,
            description,
            reward,
            xp
        };

        db.quests.push(quest);

        if (!saveDB()) {
            return res.status(500).json({
                error: "Не удалось сохранить квест."
            });
        }

        io.emit("quests:update");

        res.json({
            success: true,
            quest
        });

    } catch (error) {
        console.error("CREATE QUEST:", error);

        res.status(500).json({
            error: "Ошибка создания квеста."
        });
    }
});

/* =========================================================
   ADMIN DELETE QUEST
========================================================= */

app.delete("/api/admin/quests/:id", adminAuth, (req, res) => {
    const index = db.quests.findIndex(
        q => q.id === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({
            error: "Квест не найден."
        });
    }

    db.quests.splice(index, 1);

    if (!saveDB()) {
        return res.status(500).json({
            error: "Не удалось удалить квест."
        });
    }

    io.emit("quests:update");

    res.json({
        success: true
    });
});

/* =========================================================
   ADMIN GET QUESTS
========================================================= */

app.get("/api/admin/quests", adminAuth, (req, res) => {
    res.json({
        success: true,
        quests: db.quests
    });
});

/* =========================================================
   SOCKET
========================================================= */

io.on("connection", socket => {
    console.log("Socket connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Socket disconnected:", socket.id);
    });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
        error: "Внутренняя ошибка сервера."
    });
});

/* =========================================================
   START
========================================================= */

server.listen(PORT, () => {
    console.log("");
    console.log("======================================");
    console.log("       ASTRO ONLINE SERVER");
    console.log("======================================");
    console.log("Server: http://localhost:" + PORT);
    console.log("Database: " + DB_FILE);
    console.log("Users:", db.users.length);
    console.log("Ranks:", db.ranks.length);
    console.log("Quests:", db.quests.length);
    console.log("======================================");
    console.log("");
});
