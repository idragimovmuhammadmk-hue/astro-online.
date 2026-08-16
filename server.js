const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* =========================================================
   DATABASE
========================================================= */

const DEFAULT_DATA = {
    users: [],
    ranks: [
        {
            id: "bronze",
            rankId: "bronze",
            name: "BRONZE",
            title: "Начинающий",
            price: 1000,
            color: "#cd7f32",
            icon: "🥉"
        },
        {
            id: "silver",
            rankId: "silver",
            name: "SILVER",
            title: "Опытный",
            price: 5000,
            color: "#c0c0c0",
            icon: "🥈"
        },
        {
            id: "gold",
            rankId: "gold",
            name: "GOLD",
            title: "Элитный",
            price: 15000,
            color: "#ffd700",
            icon: "🥇"
        },
        {
            id: "diamond",
            rankId: "diamond",
            name: "DIAMOND",
            title: "Мастер",
            price: 50000,
            color: "#55ddff",
            icon: "💎"
        }
    ],
    quests: [
        {
            id: "welcome",
            questId: "welcome",
            title: "Добро пожаловать",
            description: "Получите стартовую награду.",
            reward: 500,
            xp: 100
        }
    ]
};

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(DEFAULT_DATA, null, 2),
                "utf8"
            );
            return JSON.parse(JSON.stringify(DEFAULT_DATA));
        }

        const raw = fs.readFileSync(DATA_FILE, "utf8");
        const data = JSON.parse(raw);

        if (!Array.isArray(data.users)) data.users = [];
        if (!Array.isArray(data.ranks)) data.ranks = [];
        if (!Array.isArray(data.quests)) data.quests = [];

        return data;
    } catch (err) {
        console.error("Ошибка чтения data.json:", err);

        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(DEFAULT_DATA, null, 2),
            "utf8"
        );

        return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
}

let db = loadData();

function saveData() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(db, null, 2),
            "utf8"
        );
        return true;
    } catch (err) {
        console.error("Ошибка сохранения:", err);
        return false;
    }
}

/* =========================================================
   PASSWORD
========================================================= */

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
    try {
        const parts = String(stored).split(":");

        if (parts.length !== 2) return false;

        const salt = parts[0];
        const oldHash = parts[1];

        const newHash = crypto
            .scryptSync(password, salt, 64)
            .toString("hex");

        return crypto.timingSafeEqual(
            Buffer.from(oldHash, "hex"),
            Buffer.from(newHash, "hex")
        );
    } catch {
        return false;
    }
}

/* =========================================================
   TOKENS
========================================================= */

const sessions = new Map();

function createToken(userId) {
    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
        userId,
        created: Date.now()
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

    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Вы не авторизованы"
        });
    }

    const token = header.slice(7);
    const user = getUserFromToken(token);

    if (!user) {
        return res.status(401).json({
            error: "Сессия недействительна"
        });
    }

    req.token = token;
    req.user = user;

    next();
}

function admin(req, res, next) {
    if (!req.user.admin) {
        return res.status(403).json({
            error: "Нет доступа к админке"
        });
    }

    next();
}

/* =========================================================
   USER PUBLIC DATA
========================================================= */

function publicUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: Number(user.balance || 0),
        elo: Number(user.elo || 0),
        xp: Number(user.xp || 0),
        wins: Number(user.wins || 0),
        ownedRanks: Array.isArray(user.ownedRanks)
            ? user.ownedRanks
            : [],
        rankId: user.rankId || null,
        admin: Boolean(user.admin)
    };
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/register", (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (username.length < 3) {
            return res.status(400).json({
                error: "Никнейм должен содержать минимум 3 символа"
            });
        }

        if (username.length > 30) {
            return res.status(400).json({
                error: "Никнейм слишком длинный"
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                error: "Введите правильный Email"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 6 символов"
            });
        }

        const emailExists = db.users.some(
            u => u.email.toLowerCase() === email
        );

        if (emailExists) {
            return res.status(409).json({
                error: "Этот Email уже зарегистрирован"
            });
        }

        const usernameExists = db.users.some(
            u => u.username.toLowerCase() === username.toLowerCase()
        );

        if (usernameExists) {
            return res.status(409).json({
                error: "Этот никнейм уже занят"
            });
        }

        const user = {
            id: crypto.randomUUID(),
            username,
            email,
            password: hashPassword(password),

            balance: 10000,
            elo: 1000,
            xp: 0,
            wins: 0,

            ownedRanks: [],
            rankId: null,

            claimedQuests: [],

            admin: db.users.length === 0,

            createdAt: Date.now()
        };

        db.users.push(user);

        saveData();

        const token = createToken(user.id);

        return res.json({
            ok: true,
            token,
            user: publicUser(user)
        });

    } catch (err) {
        console.error("REGISTER:", err);

        res.status(500).json({
            error: "Ошибка регистрации"
        });
    }
});

app.post("/api/login", (req, res) => {
    try {
        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const password = String(req.body.password || "");

        if (!email || !password) {
            return res.status(400).json({
                error: "Введите Email и пароль"
            });
        }

        const user = db.users.find(
            u => u.email.toLowerCase() === email
        );

        if (!user) {
            return res.status(401).json({
                error: "Неверный Email или пароль"
            });
        }

        if (!checkPassword(password, user.password)) {
            return res.status(401).json({
                error: "Неверный Email или пароль"
            });
        }

        const token = createToken(user.id);

        res.json({
            ok: true,
            token,
            user: publicUser(user)
        });

    } catch (err) {
        console.error("LOGIN:", err);

        res.status(500).json({
            error: "Ошибка авторизации"
        });
    }
});

app.post("/api/logout", auth, (req, res) => {
    sessions.delete(req.token);

    res.json({
        ok: true
    });
});

app.get("/api/me", auth, (req, res) => {
    res.json({
        ok: true,
        user: publicUser(req.user)
    });
});

/* =========================================================
   RANK SYSTEM
========================================================= */

function getRankForUser(user) {
    if (!user || !user.rankId) return null;

    return db.ranks.find(
        r => r.rankId === user.rankId || r.id === user.rankId
    ) || null;
}

app.get("/api/ranks", (req, res) => {
    res.json({
        ok: true,
        ranks: db.ranks
    });
});

app.get("/api/my-rank", auth, (req, res) => {
    res.json({
        ok: true,
        rank: getRankForUser(req.user)
    });
});

app.post("/api/ranks/:id/buy", auth, (req, res) => {
    try {
        const rank = db.ranks.find(
            r =>
                r.rankId === req.params.id ||
                r.id === req.params.id
        );

        if (!rank) {
            return res.status(404).json({
                error: "Ранг не найден"
            });
        }

        if (!Array.isArray(req.user.ownedRanks)) {
            req.user.ownedRanks = [];
        }

        const alreadyOwned =
            req.user.ownedRanks.includes(rank.rankId);

        if (alreadyOwned) {
            return res.status(400).json({
                error: "Этот ранг уже куплен"
            });
        }

        const price = Number(rank.price || 0);

        if (Number(req.user.balance || 0) < price) {
            return res.status(400).json({
                error: "Недостаточно денег"
            });
        }

        /* ДЕНЬГИ ДЕЙСТВИТЕЛЬНО СПИСЫВАЮТСЯ */
        req.user.balance -= price;

        /* РАНГ ДЕЙСТВИТЕЛЬНО ДОБАВЛЯЕТСЯ */
        req.user.ownedRanks.push(rank.rankId);

        /* ПОКУПАЕМЫЙ РАНГ СТАНОВИТСЯ ТЕКУЩИМ */
        req.user.rankId = rank.rankId;

        saveData();

        io.emit("leaderboard:update");

        res.json({
            ok: true,
            message: "Ранг куплен",
            user: publicUser(req.user),
            rank
        });

    } catch (err) {
        console.error("BUY RANK:", err);

        res.status(500).json({
            error: "Ошибка покупки ранга"
        });
    }
});

/* =========================================================
   QUESTS
========================================================= */

app.get("/api/quests", (req, res) => {
    res.json({
        ok: true,
        quests: db.quests
    });
});

app.post("/api/quests/:id/claim", auth, (req, res) => {
    try {
        const quest = db.quests.find(
            q =>
                q.questId === req.params.id ||
                q.id === req.params.id
        );

        if (!quest) {
            return res.status(404).json({
                error: "Квест не найден"
            });
        }

        if (!Array.isArray(req.user.claimedQuests)) {
            req.user.claimedQuests = [];
        }

        if (req.user.claimedQuests.includes(quest.questId)) {
            return res.status(400).json({
                error: "Этот квест уже выполнен"
            });
        }

        const reward = Number(quest.reward || 0);
        const xp = Number(quest.xp || 0);

        req.user.balance += reward;
        req.user.xp += xp;

        req.user.claimedQuests.push(
            quest.questId
        );

        saveData();

        io.emit("leaderboard:update");

        res.json({
            ok: true,
            reward,
            xp,
            user: publicUser(req.user)
        });

    } catch (err) {
        console.error("QUEST:", err);

        res.status(500).json({
            error: "Ошибка выполнения квеста"
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
            return Number(b.elo) - Number(a.elo);
        });

    res.json({
        ok: true,
        players
    });
});

/* =========================================================
   ADMIN - USERS
========================================================= */

app.get(
    "/api/admin/users",
    auth,
    admin,
    (req, res) => {
        const search = String(
            req.query.search || ""
        ).trim().toLowerCase();

        let users = db.users;

        if (search) {
            users = users.filter(u =>
                u.username.toLowerCase().includes(search) ||
                u.email.toLowerCase().includes(search)
            );
        }

        res.json({
            ok: true,
            users: users.map(publicUser)
        });
    }
);

app.put(
    "/api/admin/users/:id",
    auth,
    admin,
    (req, res) => {
        const user = db.users.find(
            u => u.id === req.params.id
        );

        if (!user) {
            return res.status(404).json({
                error: "Игрок не найден"
            });
        }

        if (req.body.elo !== undefined) {
            user.elo = Math.max(
                0,
                Number(req.body.elo) || 0
            );
        }

        if (req.body.wins !== undefined) {
            user.wins = Math.max(
                0,
                Number(req.body.wins) || 0
            );
        }

        if (req.body.balance !== undefined) {
            user.balance = Math.max(
                0,
                Number(req.body.balance) || 0
            );
        }

        if (req.body.xp !== undefined) {
            user.xp = Math.max(
                0,
                Number(req.body.xp) || 0
            );
        }

        if (req.body.rankId !== undefined) {
            user.rankId =
                req.body.rankId || null;
        }

        saveData();

        io.emit("leaderboard:update");

        res.json({
            ok: true,
            user: publicUser(user)
        });
    }
);

/* =========================================================
   ADMIN - GIVE
========================================================= */

app.post(
    "/api/admin/users/:id/give",
    auth,
    admin,
    (req, res) => {
        const user = db.users.find(
            u => u.id === req.params.id
        );

        if (!user) {
            return res.status(404).json({
                error: "Игрок не найден"
            });
        }

        const money = Number(req.body.money || 0);
        const elo = Number(req.body.elo || 0);
        const xp = Number(req.body.xp || 0);
        const wins = Number(req.body.wins || 0);

        user.balance += money;
        user.elo += elo;
        user.xp += xp;
        user.wins += wins;

        saveData();

        io.emit("leaderboard:update");

        res.json({
            ok: true,
            user: publicUser(user)
        });
    }
);

/* =========================================================
   ADMIN - RANKS
========================================================= */

app.get(
    "/api/admin/ranks",
    auth,
    admin,
    (req, res) => {
        res.json({
            ok: true,
            ranks: db.ranks
        });
    }
);

app.post(
    "/api/admin/ranks",
    auth,
    admin,
    (req, res) => {
        const rankId = String(
            req.body.rankId || ""
        ).trim();

        const name = String(
            req.body.name || ""
        ).trim();

        if (!rankId || !name) {
            return res.status(400).json({
                error: "ID и название обязательны"
            });
        }

        if (
            db.ranks.some(
                r => r.rankId === rankId
            )
        ) {
            return res.status(409).json({
                error: "Такой ранг уже существует"
            });
        }

        const rank = {
            id: crypto.randomUUID(),
            rankId,
            name,
            title: String(req.body.title || ""),
            price: Math.max(
                0,
                Number(req.body.price) || 0
            ),
            color: String(
                req.body.color || "#9b7cff"
            ),
            icon: String(
                req.body.icon || "★"
            )
        };

        db.ranks.push(rank);

        saveData();

        io.emit("ranks:update");

        res.json({
            ok: true,
            rank
        });
    }
);

app.delete(
    "/api/admin/ranks/:id",
    auth,
    admin,
    (req, res) => {
        const index = db.ranks.findIndex(
            r =>
                r.id === req.params.id ||
                r.rankId === req.params.id
        );

        if (index === -1) {
            return res.status(404).json({
                error: "Ранг не найден"
            });
        }

        db.ranks.splice(index, 1);

        saveData();

        io.emit("ranks:update");

        res.json({
            ok: true
        });
    }
);

/* =========================================================
   ADMIN - QUESTS
========================================================= */

app.get(
    "/api/admin/quests",
    auth,
    admin,
    (req, res) => {
        res.json({
            ok: true,
            quests: db.quests
        });
    }
);

app.post(
    "/api/admin/quests",
    auth,
    admin,
    (req, res) => {
        const questId = String(
            req.body.questId || ""
        ).trim();

        const title = String(
            req.body.title || ""
        ).trim();

        if (!questId || !title) {
            return res.status(400).json({
                error: "ID и название обязательны"
            });
        }

        if (
            db.quests.some(
                q => q.questId === questId
            )
        ) {
            return res.status(409).json({
                error: "Такой квест уже существует"
            });
        }

        const quest = {
            id: crypto.randomUUID(),
            questId,
            title,
            description: String(
                req.body.description || ""
            ),
            reward: Math.max(
                0,
                Number(req.body.reward) || 0
            ),
            xp: Math.max(
                0,
                Number(req.body.xp) || 0
            )
        };

        db.quests.push(quest);

        saveData();

        io.emit("quests:update");

        res.json({
            ok: true,
            quest
        });
    }
);

app.delete(
    "/api/admin/quests/:id",
    auth,
    admin,
    (req, res) => {
        const index = db.quests.findIndex(
            q =>
                q.id === req.params.id ||
                q.questId === req.params.id
        );

        if (index === -1) {
            return res.status(404).json({
                error: "Квест не найден"
            });
        }

        db.quests.splice(index, 1);

        saveData();

        io.emit("quests:update");

        res.json({
            ok: true
        });
    }
);

/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", socket => {
    console.log("Клиент подключён:", socket.id);

    socket.on("disconnect", () => {
        console.log("Клиент отключён:", socket.id);
    });
});

/* =========================================================
   ERRORS
========================================================= */

app.use((err, req, res, next) => {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
        error: "Внутренняя ошибка сервера"
    });
});

/* =========================================================
   START
========================================================= */

server.listen(PORT, () => {
    console.log("");
    console.log("====================================");
    console.log("       ASTRO ONLINE SERVER");
    console.log("====================================");
    console.log(`Сайт: http://localhost:${PORT}`);
    console.log(`Пользователей: ${db.users.length}`);
    console.log(`Рангов: ${db.ranks.length}`);
    console.log(`Квестов: ${db.quests.length}`);
    console.log("====================================");
    console.log("");
});
