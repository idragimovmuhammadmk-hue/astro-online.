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
const DATA_FILE = path.join(__dirname, "astro-data.json");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

/* =========================================================
   DATABASE
========================================================= */

function defaultData() {
    return {
        users: [],
        ranks: [
            {
                id: "starter",
                rankId: "starter",
                name: "STARTER",
                title: "Новичок",
                price: 0,
                color: "#8b8b9c",
                icon: "✦"
            },
            {
                id: "silver",
                rankId: "silver",
                name: "SILVER",
                title: "Серебряный",
                price: 500,
                color: "#bfc7d5",
                icon: "◆"
            },
            {
                id: "gold",
                rankId: "gold",
                name: "GOLD",
                title: "Золотой",
                price: 2500,
                color: "#ffd84d",
                icon: "★"
            },
            {
                id: "diamond",
                rankId: "diamond",
                name: "DIAMOND",
                title: "Алмазный",
                price: 10000,
                color: "#55eaff",
                icon: "♦"
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
            }
        ]
    };
}

function saveData() {
    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(db, null, 2),
        "utf8"
    );
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const data = defaultData();
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2),
            "utf8"
        );
        return data;
    }

    try {
        const data = JSON.parse(
            fs.readFileSync(DATA_FILE, "utf8")
        );

        if (!Array.isArray(data.users)) data.users = [];
        if (!Array.isArray(data.ranks)) data.ranks = [];
        if (!Array.isArray(data.quests)) data.quests = [];

        return data;
    } catch (error) {
        console.error("Ошибка чтения astro-data.json:", error);

        const backup = DATA_FILE + ".backup";

        try {
            fs.copyFileSync(DATA_FILE, backup);
        } catch (_) {}

        const data = defaultData();

        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2),
            "utf8"
        );

        return data;
    }
}

const db = loadData();

/* =========================================================
   ADMIN
========================================================= */

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL || "admin@astro.local";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "admin123";

/*
    Вход администратора:

    Email:    admin@astro.local
    Пароль:   admin123

    Можно поменять через переменные окружения:
    ADMIN_EMAIL
    ADMIN_PASSWORD
*/

/* =========================================================
   SESSIONS
========================================================= */

const sessions = new Map();

function createToken() {
    return crypto.randomBytes(32).toString("hex");
}

/* =========================================================
   PASSWORD
========================================================= */

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(String(password))
        .digest("hex");
}

/* =========================================================
   HELPERS
========================================================= */

function id() {
    return crypto.randomUUID();
}

function normalizeUser(user) {
    if (!user) return null;

    if (!Array.isArray(user.ownedRanks)) {
        user.ownedRanks = [];
    }

    if (!Array.isArray(user.claimedQuests)) {
        user.claimedQuests = [];
    }

    if (typeof user.balance !== "number") {
        user.balance = Number(user.balance) || 0;
    }

    if (typeof user.elo !== "number") {
        user.elo = Number(user.elo) || 0;
    }

    if (typeof user.xp !== "number") {
        user.xp = Number(user.xp) || 0;
    }

    if (typeof user.wins !== "number") {
        user.wins = Number(user.wins) || 0;
    }

    if (!("activeRank" in user)) {
        user.activeRank = null;
    }

    return user;
}

function findUserById(userId) {
    return db.users.find(
        u => String(u.id) === String(userId)
    );
}

function findUserByEmail(email) {
    return db.users.find(
        u =>
            String(u.email).toLowerCase() ===
            String(email).toLowerCase()
    );
}

function findRank(rankId) {
    return db.ranks.find(
        r =>
            String(r.id) === String(rankId) ||
            String(r.rankId) === String(rankId)
    );
}

function findQuest(questId) {
    return db.quests.find(
        q =>
            String(q.id) === String(questId) ||
            String(q.questId) === String(questId)
    );
}

function publicUser(user) {
    normalizeUser(user);

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        elo: user.elo,
        xp: user.xp,
        wins: user.wins,
        ownedRanks: user.ownedRanks,
        activeRank: user.activeRank,
        claimedQuests: user.claimedQuests
    };
}

function getRankForUser(user) {
    if (!user || !user.activeRank) {
        return null;
    }

    return findRank(user.activeRank) || null;
}

function getCurrentUserFromRequest(req) {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return null;
    }

    const token = auth.slice(7);
    const session = sessions.get(token);

    if (!session) {
        return null;
    }

    if (session.expiresAt < Date.now()) {
        sessions.delete(token);
        return null;
    }

    return findUserById(session.userId) || null;
}

function requireAuth(req, res, next) {
    const user = getCurrentUserFromRequest(req);

    if (!user) {
        return res.status(401).json({
            error: "Необходим вход в аккаунт"
        });
    }

    normalizeUser(user);

    req.user = user;

    next();
}

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Необходим вход администратора"
        });
    }

    const token = auth.slice(7);
    const session = sessions.get(token);

    if (!session || session.expiresAt < Date.now()) {
        return res.status(401).json({
            error: "Сессия администратора истекла"
        });
    }

    if (session.admin !== true) {
        return res.status(403).json({
            error: "Недостаточно прав"
        });
    }

    req.admin = true;
    req.adminEmail = session.email;

    next();
}

function broadcastAll() {
    io.emit("ranks:update");
    io.emit("quests:update");
    io.emit("leaderboard:update");
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "index.html")
    );
});

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        message: "ASTRO ONLINE SERVER работает",
        users: db.users.length,
        ranks: db.ranks.length,
        quests: db.quests.length
    });
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", (req, res) => {
    try {
        const username =
            String(req.body.username || "").trim();

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body.password || "");

        if (username.length < 2) {
            return res.status(400).json({
                error: "Никнейм должен содержать минимум 2 символа"
            });
        }

        if (username.length > 30) {
            return res.status(400).json({
                error: "Никнейм слишком длинный"
            });
        }

        if (!email.includes("@")) {
            return res.status(400).json({
                error: "Введите корректный email"
            });
        }

        if (password.length < 4) {
            return res.status(400).json({
                error: "Пароль должен содержать минимум 4 символа"
            });
        }

        if (findUserByEmail(email)) {
            return res.status(409).json({
                error: "Этот email уже зарегистрирован"
            });
        }

        const usernameExists = db.users.some(
            u =>
                String(u.username).toLowerCase() ===
                username.toLowerCase()
        );

        if (usernameExists) {
            return res.status(409).json({
                error: "Этот никнейм уже занят"
            });
        }

        const starter =
            findRank("starter");

        const user = {
            id: id(),
            username,
            email,
            passwordHash: hashPassword(password),

            balance: 5000,
            elo: 1000,
            xp: 0,
            wins: 0,

            ownedRanks: starter
                ? [starter.rankId]
                : [],

            activeRank: starter
                ? starter.rankId
                : null,

            claimedQuests: [],

            createdAt: new Date().toISOString()
        };

        db.users.push(user);
        saveData();

        const token = createToken();

        sessions.set(token, {
            userId: user.id,
            admin: false,
            expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30
        });

        res.json({
            token,
            user: publicUser(user)
        });

        io.emit("leaderboard:update");
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка регистрации"
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", (req, res) => {
    try {
        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body.password || "");

        /*
           АДМИН
        */

        if (
            email === ADMIN_EMAIL.toLowerCase() &&
            password === ADMIN_PASSWORD
        ) {
            const token = createToken();

            sessions.set(token, {
                admin: true,
                email,
                expiresAt:
                    Date.now() +
                    1000 * 60 * 60 * 24 * 30
            });

            return res.json({
                token,
                admin: true,
                user: {
                    id: "admin",
                    username: "Administrator",
                    email,
                    balance: 0,
                    elo: 999999,
                    xp: 999999,
                    wins: 999999,
                    ownedRanks: [],
                    activeRank: null
                }
            });
        }

        /*
           ОБЫЧНЫЙ ИГРОК
        */

        const user = findUserByEmail(email);

        if (!user) {
            return res.status(401).json({
                error: "Неверный email или пароль"
            });
        }

        normalizeUser(user);

        if (
            user.passwordHash !==
            hashPassword(password)
        ) {
            return res.status(401).json({
                error: "Неверный email или пароль"
            });
        }

        const token = createToken();

        sessions.set(token, {
            userId: user.id,
            admin: false,
            expiresAt:
                Date.now() +
                1000 * 60 * 60 * 24 * 30
        });

        res.json({
            token,
            admin: false,
            user: publicUser(user)
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка входа"
        });
    }
});

/* =========================================================
   ME
========================================================= */

app.get("/api/me", requireAuth, (req, res) => {
    const rank = getRankForUser(req.user);

    res.json({
        user: {
            ...publicUser(req.user),
            rank
        }
    });
});

/* =========================================================
   RANKS
========================================================= */

app.get("/api/ranks", (req, res) => {
    res.json({
        ranks: db.ranks
    });
});

/* =========================================================
   BUY RANK
========================================================= */

app.post(
    "/api/ranks/:rankId/buy",
    requireAuth,
    (req, res) => {
        try {
            const rank =
                findRank(req.params.rankId);

            if (!rank) {
                return res.status(404).json({
                    error: "Ранг не найден"
                });
            }

            normalizeUser(req.user);

            if (
                req.user.ownedRanks.includes(
                    rank.rankId
                )
            ) {
                /*
                   Если ранг уже есть —
                   просто делаем его активным.
                */

                req.user.activeRank = rank.rankId;

                saveData();

                return res.json({
                    message: "Ранг уже был куплен. Он установлен активным.",
                    user: {
                        ...publicUser(req.user),
                        rank
                    }
                });
            }

            const price =
                Math.max(0, Number(rank.price) || 0);

            if (req.user.balance < price) {
                return res.status(400).json({
                    error:
                        "Недостаточно денег. Нужно: " +
                        price.toLocaleString() +
                        " ₽"
                });
            }

            /*
               ВАЖНО:
               деньги реально списываются
            */

            req.user.balance -= price;

            if (
                !req.user.ownedRanks.includes(
                    rank.rankId
                )
            ) {
                req.user.ownedRanks.push(
                    rank.rankId
                );
            }

            /*
               Купленный ранг автоматически становится
               текущим рангом игрока.
            */

            req.user.activeRank =
                rank.rankId;

            saveData();

            res.json({
                message: "Ранг успешно куплен",
                user: {
                    ...publicUser(req.user),
                    rank
                }
            });

            io.emit("leaderboard:update");
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка покупки ранга"
            });
        }
    }
);

/* =========================================================
   QUESTS
========================================================= */

app.get("/api/quests", (req, res) => {
    res.json({
        quests: db.quests
    });
});

/* =========================================================
   CLAIM QUEST
========================================================= */

app.post(
    "/api/quests/:questId/claim",
    requireAuth,
    (req, res) => {
        try {
            const quest =
                findQuest(req.params.questId);

            if (!quest) {
                return res.status(404).json({
                    error: "Квест не найден"
                });
            }

            normalizeUser(req.user);

            if (
                req.user.claimedQuests.includes(
                    quest.questId
                )
            ) {
                return res.status(400).json({
                    error: "Этот квест уже выполнен"
                });
            }

            const reward =
                Math.max(
                    0,
                    Number(quest.reward) || 0
                );

            const xp =
                Math.max(
                    0,
                    Number(quest.xp) || 0
                );

            req.user.balance += reward;
            req.user.xp += xp;

            req.user.claimedQuests.push(
                quest.questId
            );

            saveData();

            res.json({
                message: "Квест выполнен",
                reward,
                xp,
                user: {
                    ...publicUser(req.user),
                    rank: getRankForUser(req.user)
                }
            });

            io.emit("leaderboard:update");
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка выполнения квеста"
            });
        }
    }
);

/* =========================================================
   LEADERBOARD
========================================================= */

app.get("/api/leaderboard", (req, res) => {
    try {
        const players =
            db.users
                .map(normalizeUser)
                .map(user => {
                    const rank =
                        getRankForUser(user);

                    return {
                        id: user.id,
                        username: user.username,
                        elo: user.elo,
                        xp: user.xp,
                        wins: user.wins,
                        balance: user.balance,
                        activeRank: user.activeRank,
                        rank
                    };
                })
                .sort(
                    (a, b) =>
                        Number(b.elo) -
                        Number(a.elo)
                );

        res.json({
            players
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Ошибка загрузки рейтинга"
        });
    }
});

/* =========================================================
   ADMIN USERS
========================================================= */

app.get(
    "/api/admin/users",
    requireAdmin,
    (req, res) => {
        try {
            const search =
                String(
                    req.query.search || ""
                )
                    .trim()
                    .toLowerCase();

            let users = db.users
                .map(normalizeUser);

            if (search) {
                users = users.filter(
                    u =>
                        String(
                            u.username
                        )
                            .toLowerCase()
                            .includes(search) ||
                        String(
                            u.email
                        )
                            .toLowerCase()
                            .includes(search)
                );
            }

            res.json({
                users: users.map(u => ({
                    ...publicUser(u),
                    rank: getRankForUser(u)
                }))
            });
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка загрузки игроков"
            });
        }
    }
);

/* =========================================================
   ADMIN UPDATE PLAYER
   ELO / WINS / BALANCE
========================================================= */

app.put(
    "/api/admin/users/:id",
    requireAdmin,
    (req, res) => {
        try {
            const user =
                findUserById(req.params.id);

            if (!user) {
                return res.status(404).json({
                    error: "Игрок не найден"
                });
            }

            normalizeUser(user);

            if (
                req.body.elo !== undefined
            ) {
                user.elo = Math.max(
                    0,
                    Number(req.body.elo) || 0
                );
            }

            if (
                req.body.wins !== undefined
            ) {
                user.wins = Math.max(
                    0,
                    Number(req.body.wins) || 0
                );
            }

            if (
                req.body.balance !== undefined
            ) {
                user.balance = Math.max(
                    0,
                    Number(req.body.balance) || 0
                );
            }

            if (
                req.body.xp !== undefined
            ) {
                user.xp = Math.max(
                    0,
                    Number(req.body.xp) || 0
                );
            }

            saveData();

            res.json({
                message: "Игрок сохранён",
                user: {
                    ...publicUser(user),
                    rank: getRankForUser(user)
                }
            });

            io.emit("leaderboard:update");
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка изменения игрока"
            });
        }
    }
);

/* =========================================================
   ADMIN GET RANKS
========================================================= */

app.get(
    "/api/admin/ranks",
    requireAdmin,
    (req, res) => {
        res.json({
            ranks: db.ranks
        });
    }
);

/* =========================================================
   ADMIN CREATE RANK
========================================================= */

app.post(
    "/api/admin/ranks",
    requireAdmin,
    (req, res) => {
        try {
            const rankId =
                String(
                    req.body.rankId || ""
                ).trim();

            const name =
                String(
                    req.body.name || ""
                ).trim();

            const title =
                String(
                    req.body.title || ""
                ).trim();

            const price =
                Math.max(
                    0,
                    Number(req.body.price) || 0
                );

            const color =
                String(
                    req.body.color || "#ffffff"
                ).trim();

            const icon =
                String(
                    req.body.icon || "★"
                ).trim();

            if (!rankId) {
                return res.status(400).json({
                    error: "Введите ID ранга"
                });
            }

            if (!name) {
                return res.status(400).json({
                    error: "Введите название ранга"
                });
            }

            if (
                db.ranks.some(
                    r =>
                        String(r.rankId)
                            .toLowerCase() ===
                        rankId.toLowerCase()
                )
            ) {
                return res.status(409).json({
                    error: "Такой ранг уже существует"
                });
            }

            const rank = {
                id: id(),
                rankId,
                name,
                title,
                price,
                color,
                icon
            };

            db.ranks.push(rank);

            saveData();

            res.json({
                message: "Ранг создан",
                rank
            });

            broadcastAll();
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка создания ранга"
            });
        }
    }
);

/* =========================================================
   ADMIN DELETE RANK
========================================================= */

app.delete(
    "/api/admin/ranks/:id",
    requireAdmin,
    (req, res) => {
        try {
            const index =
                db.ranks.findIndex(
                    r =>
                        String(r.id) ===
                            String(req.params.id) ||
                        String(r.rankId) ===
                            String(req.params.id)
                );

            if (index === -1) {
                return res.status(404).json({
                    error: "Ранг не найден"
                });
            }

            const rank =
                db.ranks[index];

            /*
               Убираем удалённый ранг
               из коллекции игроков.
            */

            for (const user of db.users) {
                normalizeUser(user);

                user.ownedRanks =
                    user.ownedRanks.filter(
                        r =>
                            r !== rank.rankId
                    );

                if (
                    user.activeRank ===
                    rank.rankId
                ) {
                    user.activeRank = null;
                }
            }

            db.ranks.splice(index, 1);

            saveData();

            res.json({
                message: "Ранг удалён"
            });

            broadcastAll();
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка удаления ранга"
            });
        }
    }
);

/* =========================================================
   ADMIN GIVE RANK
========================================================= */

app.post(
    "/api/admin/users/:userId/ranks/:rankId",
    requireAdmin,
    (req, res) => {
        try {
            const user =
                findUserById(
                    req.params.userId
                );

            if (!user) {
                return res.status(404).json({
                    error: "Игрок не найден"
                });
            }

            const rank =
                findRank(
                    req.params.rankId
                );

            if (!rank) {
                return res.status(404).json({
                    error: "Ранг не найден"
                });
            }

            normalizeUser(user);

            if (
                !user.ownedRanks.includes(
                    rank.rankId
                )
            ) {
                user.ownedRanks.push(
                    rank.rankId
                );
            }

            user.activeRank =
                rank.rankId;

            saveData();

            res.json({
                message:
                    "Ранг выдан игроку",
                user: {
                    ...publicUser(user),
                    rank
                }
            });

            broadcastAll();
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка выдачи ранга"
            });
        }
    }
);

/* =========================================================
   ADMIN REMOVE RANK
========================================================= */

app.delete(
    "/api/admin/users/:userId/ranks/:rankId",
    requireAdmin,
    (req, res) => {
        try {
            const user =
                findUserById(
                    req.params.userId
                );

            if (!user) {
                return res.status(404).json({
                    error: "Игрок не найден"
                });
            }

            const rank =
                findRank(
                    req.params.rankId
                );

            if (!rank) {
                return res.status(404).json({
                    error: "Ранг не найден"
                });
            }

            normalizeUser(user);

            user.ownedRanks =
                user.ownedRanks.filter(
                    r =>
                        r !== rank.rankId
                );

            if (
                user.activeRank ===
                rank.rankId
            ) {
                user.activeRank = null;
            }

            saveData();

            res.json({
                message:
                    "Ранг снят с игрока",
                user: {
                    ...publicUser(user),
                    rank: getRankForUser(user)
                }
            });

            broadcastAll();
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка снятия ранга"
            });
        }
    }
);

/* =========================================================
   ADMIN QUESTS
========================================================= */

app.get(
    "/api/admin/quests",
    requireAdmin,
    (req, res) => {
        res.json({
            quests: db.quests
        });
    }
);

/* =========================================================
   ADMIN CREATE QUEST
========================================================= */

app.post(
    "/api/admin/quests",
    requireAdmin,
    (req, res) => {
        try {
            const questId =
                String(
                    req.body.questId || ""
                ).trim();

            const title =
                String(
                    req.body.title || ""
                ).trim();

            const description =
                String(
                    req.body.description || ""
                ).trim();

            const reward =
                Math.max(
                    0,
                    Number(req.body.reward) || 0
                );

            const xp =
                Math.max(
                    0,
                    Number(req.body.xp) || 0
                );

            if (!questId) {
                return res.status(400).json({
                    error: "Введите ID квеста"
                });
            }

            if (!title) {
                return res.status(400).json({
                    error: "Введите название квеста"
                });
            }

            if (
                db.quests.some(
                    q =>
                        String(q.questId)
                            .toLowerCase() ===
                        questId.toLowerCase()
                )
            ) {
                return res.status(409).json({
                    error:
                        "Такой квест уже существует"
                });
            }

            const quest = {
                id: id(),
                questId,
                title,
                description,
                reward,
                xp
            };

            db.quests.push(quest);

            saveData();

            res.json({
                message: "Квест создан",
                quest
            });

            broadcastAll();
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка создания квеста"
            });
        }
    }
);

/* =========================================================
   ADMIN DELETE QUEST
========================================================= */

app.delete(
    "/api/admin/quests/:id",
    requireAdmin,
    (req, res) => {
        try {
            const index =
                db.quests.findIndex(
                    q =>
                        String(q.id) ===
                            String(req.params.id) ||
                        String(q.questId) ===
                            String(req.params.id)
                );

            if (index === -1) {
                return res.status(404).json({
                    error: "Квест не найден"
                });
            }

            db.quests.splice(index, 1);

            saveData();

            res.json({
                message: "Квест удалён"
            });

            broadcastAll();
        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Ошибка удаления квеста"
            });
        }
    }
);

/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", socket => {
    console.log(
        "ASTRO: подключён пользователь",
        socket.id
    );

    socket.on("disconnect", () => {
        console.log(
            "ASTRO: пользователь отключён",
            socket.id
        );
    });
});

/* =========================================================
   404 API
========================================================= */

app.use("/api", (req, res) => {
    res.status(404).json({
        error:
            "API маршрут не найден: " +
            req.method +
            " " +
            req.originalUrl
    });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
    console.error("SERVER ERROR:", err);

    if (res.headersSent) {
        return next(err);
    }

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
    console.log("");
    console.log(
        "Сайт: http://localhost:" + PORT
    );
    console.log(
        "Проверка: http://localhost:" +
        PORT +
        "/api/health"
    );
    console.log("");
    console.log("АДМИН:");
    console.log(
        "Email: " + ADMIN_EMAIL
    );
    console.log(
        "Пароль: " + ADMIN_PASSWORD
    );
    console.log("");
    console.log(
        "Пользователей: " + db.users.length
    );
    console.log(
        "Рангов: " + db.ranks.length
    );
    console.log(
        "Квестов: " + db.quests.length
    );
    console.log("");
    console.log("====================================");
});
