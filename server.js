# server.js

```js
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function defaultData() {
    return {
        players: [
            {
                id: "player-1",
                username: "ASTRO",
                elo: 2500,
                xp: 1200,
                wins: 42,
                balance: 100000,
                rank: "starter"
            },
            {
                id: "player-2",
                username: "Cosmo",
                elo: 1850,
                xp: 850,
                wins: 25,
                balance: 50000,
                rank: "bronze"
            },
            {
                id: "player-3",
                username: "Nova",
                elo: 1600,
                xp: 620,
                wins: 18,
                balance: 25000,
                rank: "bronze"
            }
        ],

        ranks: [
            {
                id: "starter",
                rankId: "starter",
                name: "STARTER",
                title: "Новичок",
                price: 0,
                color: "#8b93a7",
                icon: "✦",
                minElo: 0
            },
            {
                id: "bronze",
                rankId: "bronze",
                name: "BRONZE",
                title: "Бронзовый",
                price: 10000,
                color: "#cd7f32",
                icon: "◆",
                minElo: 1000
            },
            {
                id: "silver",
                rankId: "silver",
                name: "SILVER",
                title: "Серебряный",
                price: 25000,
                color: "#c9d2df",
                icon: "◇",
                minElo: 1500
            },
            {
                id: "gold",
                rankId: "gold",
                name: "GOLD",
                title: "Золотой",
                price: 50000,
                color: "#ffd700",
                icon: "★",
                minElo: 2000
            },
            {
                id: "diamond",
                rankId: "diamond",
                name: "DIAMOND",
                title: "Алмазный",
                price: 100000,
                color: "#45eaff",
                icon: "◆",
                minElo: 2500
            }
        ],

        quests: [
            {
                id: "first-win",
                questId: "first-win",
                title: "Первая победа",
                description: "Получите свою первую победу.",
                reward: 1000,
                xp: 100
            },
            {
                id: "champion",
                questId: "champion",
                title: "Чемпион",
                description: "Наберите 10 побед.",
                reward: 5000,
                xp: 500
            }
        ]
    };
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const data = defaultData();
            saveData(data);
            return data;
        }

        const raw = fs.readFileSync(DATA_FILE, "utf8");
        const data = JSON.parse(raw);

        data.players ||= [];
        data.ranks ||= [];
        data.quests ||= [];

        return data;
    } catch (error) {
        console.error("Ошибка чтения data.json:", error);

        const data = defaultData();
        saveData(data);

        return data;
    }
}

function saveData(data) {
    const temp = DATA_FILE + ".tmp";

    fs.writeFileSync(
        temp,
        JSON.stringify(data, null, 2),
        "utf8"
    );

    fs.renameSync(temp, DATA_FILE);
}

let db = loadData();

function sendUpdate() {
    io.emit("data:update");

    io.emit("leaderboard:update");
    io.emit("ranks:update");
    io.emit("quests:update");
}

function cleanPlayer(player) {
    return {
        id: player.id,
        username: player.username,
        elo: Number(player.elo) || 0,
        xp: Number(player.xp) || 0,
        wins: Number(player.wins) || 0,
        balance: Number(player.balance) || 0,
        rank: player.rank || "starter"
    };
}

function getRankForPlayer(player) {
    const current = db.ranks
        .filter(rank => Number(rank.minElo || 0) <= Number(player.elo || 0))
        .sort((a, b) =>
            Number(b.minElo || 0) - Number(a.minElo || 0)
        )[0];

    return current || db.ranks[0] || null;
}

function syncPlayerRank(player) {
    const rank = getRankForPlayer(player);

    if (rank) {
        player.rank = rank.rankId || rank.id;
    }
}

function getLeaderboard() {
    return [...db.players]
        .sort((a, b) => {
            if (Number(b.elo) !== Number(a.elo)) {
                return Number(b.elo) - Number(a.elo);
            }

            return Number(b.xp) - Number(a.xp);
        })
        .map(cleanPlayer);
}

function validNumber(value) {
    return Number.isFinite(Number(value));
}

/* =========================
   MAIN
========================= */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   PLAYERS
========================= */

app.get("/api/players", (req, res) => {
    res.json({
        players: db.players.map(cleanPlayer)
    });
});

app.get("/api/players/:id", (req, res) => {
    const player = db.players.find(
        p => p.id === req.params.id
    );

    if (!player) {
        return res.status(404).json({
            error: "Игрок не найден"
        });
    }

    res.json({
        player: cleanPlayer(player),
        rank: getRankForPlayer(player)
    });
});

app.post("/api/players", (req, res) => {
    const username = String(req.body.username || "").trim();

    if (!username) {
        return res.status(400).json({
            error: "Введите никнейм"
        });
    }

    const exists = db.players.some(
        p => p.username.toLowerCase() === username.toLowerCase()
    );

    if (exists) {
        return res.status(400).json({
            error: "Такой игрок уже существует"
        });
    }

    const player = {
        id: "player-" + Date.now(),
        username,
        elo: 1000,
        xp: 0,
        wins: 0,
        balance: 10000,
        rank: "starter"
    };

    db.players.push(player);
    syncPlayerRank(player);
    saveData(db);
    sendUpdate();

    res.json({
        ok: true,
        player: cleanPlayer(player)
    });
});

/* =========================
   PROFILE
========================= */

app.get("/api/profile/:id", (req, res) => {
    const player = db.players.find(
        p => p.id === req.params.id
    );

    if (!player) {
        return res.status(404).json({
            error: "Профиль не найден"
        });
    }

    syncPlayerRank(player);

    res.json({
        player: cleanPlayer(player),
        rank: getRankForPlayer(player)
    });
});

/* =========================
   LEADERBOARD
========================= */

app.get("/api/leaderboard", (req, res) => {
    res.json({
        players: getLeaderboard()
    });
});

/* =========================
   RANKS
========================= */

app.get("/api/ranks", (req, res) => {
    res.json({
        ranks: db.ranks
    });
});

app.post("/api/ranks/:rankId/buy", (req, res) => {
    const playerId = String(req.body.playerId || "");
    const rankId = req.params.rankId;

    const player = db.players.find(
        p => p.id === playerId
    );

    if (!player) {
        return res.status(404).json({
            error: "Игрок не найден"
        });
    }

    const rank = db.ranks.find(
        r => (r.rankId || r.id) === rankId
    );

    if (!rank) {
        return res.status(404).json({
            error: "Ранг не найден"
        });
    }

    const price = Math.max(0, Number(rank.price) || 0);

    if (Number(player.balance) < price) {
        return res.status(400).json({
            error: "Недостаточно денег"
        });
    }

    player.balance -= price;
    player.rank = rank.rankId || rank.id;

    saveData(db);
    sendUpdate();

    res.json({
        ok: true,
        player: cleanPlayer(player),
        rank
    });
});

/* =========================
   QUESTS
========================= */

app.get("/api/quests", (req, res) => {
    res.json({
        quests: db.quests
    });
});

app.post("/api/quests/:questId/claim", (req, res) => {
    const playerId = String(req.body.playerId || "");
    const questId = req.params.questId;

    const player = db.players.find(
        p => p.id === playerId
    );

    if (!player) {
        return res.status(404).json({
            error: "Игрок не найден"
        });
    }

    const quest = db.quests.find(
        q => (q.questId || q.id) === questId
    );

    if (!quest) {
        return res.status(404).json({
            error: "Квест не найден"
        });
    }

    player.balance += Number(quest.reward) || 0;
    player.xp += Number(quest.xp) || 0;

    saveData(db);
    sendUpdate();

    res.json({
        ok: true,
        reward: Number(quest.reward) || 0,
        xp: Number(quest.xp) || 0,
        player: cleanPlayer(player)
    });
});

/* =========================
   ADMIN PLAYERS
========================= */

app.get("/api/admin/users", (req, res) => {
    const search = String(req.query.search || "")
        .trim()
        .toLowerCase();

    let players = db.players;

    if (search) {
        players = players.filter(player =>
            player.username.toLowerCase().includes(search)
        );
    }

    res.json({
        users: players.map(cleanPlayer)
    });
});

app.put("/api/admin/users/:id", (req, res) => {
    const player = db.players.find(
        p => p.id === req.params.id
    );

    if (!player) {
        return res.status(404).json({
            error: "Игрок не найден"
        });
    }

    if (req.body.elo !== undefined) {
        if (!validNumber(req.body.elo)) {
            return res.status(400).json({
                error: "Неверный ELO"
            });
        }

        player.elo = Math.max(0, Number(req.body.elo));
    }

    if (req.body.xp !== undefined) {
        if (!validNumber(req.body.xp)) {
            return res.status(400).json({
                error: "Неверный XP"
            });
        }

        player.xp = Math.max(0, Number(req.body.xp));
    }

    if (req.body.wins !== undefined) {
        if (!validNumber(req.body.wins)) {
            return res.status(400).json({
                error: "Неверное количество побед"
            });
        }

        player.wins = Math.max(0, Number(req.body.wins));
    }

    if (req.body.balance !== undefined) {
        if (!validNumber(req.body.balance)) {
            return res.status(400).json({
                error: "Неверный баланс"
            });
        }

        player.balance = Math.max(0, Number(req.body.balance));
    }

    syncPlayerRank(player);

    saveData(db);
    sendUpdate();

    res.json({
        ok: true,
        player: cleanPlayer(player),
        rank: getRankForPlayer(player)
    });
});

app.delete("/api/admin/users/:id", (req, res) => {
    const index = db.players.findIndex(
        p => p.id === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({
            error: "Игрок не найден"
        });
    }

    db.players.splice(index, 1);

    saveData(db);
    sendUpdate();

    res.json({
        ok: true
    });
});

/* =========================
   ADMIN RANKS
========================= */

app.get("/api/admin/ranks", (req, res) => {
    res.json({
        ranks: db.ranks
    });
});

app.post("/api/admin/ranks", (req, res) => {
    const rankId = String(req.body.rankId || "").trim();
    const name = String(req.body.name || "").trim();

    if (!rankId || !name) {
        return res.status(400).json({
            error: "ID и название ранга обязательны"
        });
    }

    const exists = db.ranks.some(
        r => (r.rankId || r.id) === rankId
    );

    if (exists) {
        return res.status(400).json({
            error: "Такой ранг уже существует"
        });
    }

    const rank = {
        id: rankId,
        rankId,
        name,
        title: String(req.body.title || ""),
        price: Math.max(0, Number(req.body.price) || 0),
        color: String(req.body.color || "#9b7cff"),
        icon: String(req.body.icon || "★"),
        minElo: Math.max(0, Number(req.body.minElo) || 0)
    };

    db.ranks.push(rank);

    saveData(db);
    sendUpdate();

    res.json({
        ok: true,
        rank
    });
});

app.delete("/api/admin/ranks/:id", (req, res) => {
    const index = db.ranks.findIndex(
        r => (r.id || r.rankId) === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({
            error: "Ранг не найден"
        });
    }

    if (db.ranks.length <= 1) {
        return res.status(400).json({
            error: "Нельзя удалить последний ранг"
        });
    }

    db.ranks.splice(index, 1);

    for (const player of db.players) {
        if (!db.ranks.some(
            r => (r.rankId || r.id) === player.rank
        )) {
            syncPlayerRank(player);
        }
    }

    saveData(db);
    sendUpdate();

    res.json({
        ok: true
    });
});

/* =========================
   ADMIN QUESTS
========================= */

app.get("/api/admin/quests", (req, res) => {
    res.json({
        quests: db.quests
    });
});

app.post("/api/admin/quests", (req, res) => {
    const questId = String(req.body.questId || "").trim();
    const title = String(req.body.title || "").trim();

    if (!questId || !title) {
        return res.status(400).json({
            error: "ID и название квеста обязательны"
        });
    }

    const exists = db.quests.some(
        q => (q.questId || q.id) === questId
    );

    if (exists) {
        return res.status(400).json({
            error: "Такой квест уже существует"
        });
    }

    const quest = {
        id: questId,
        questId,
        title,
        description: String(req.body.description || ""),
        reward: Math.max(0, Number(req.body.reward) || 0),
        xp: Math.max(0, Number(req.body.xp) || 0)
    };

    db.quests.push(quest);

    saveData(db);
    sendUpdate();

    res.json({
        ok: true,
        quest
    });
});

app.delete("/api/admin/quests/:id", (req, res) => {
    const index = db.quests.findIndex(
        q => (q.id || q.questId) === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({
            error: "Квест не найден"
        });
    }

    db.quests.splice(index, 1);

    saveData(db);
    sendUpdate();

    res.json({
        ok: true
    });
});

/* =========================
   SOCKET.IO
========================= */

io.on("connection", socket => {
    socket.emit("data:update");

    socket.on("refresh", () => {
        socket.emit("data:update");
    });
});

/* =========================
   ERRORS
========================= */

app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({
            error: "API маршрут не найден"
        });
    }

    res.status(404).send("Страница не найдена");
});

app.use((error, req, res, next) => {
    console.error(error);

    res.status(500).json({
        error: "Внутренняя ошибка сервера"
    });
});

/* =========================
   START
========================= */

server.listen(PORT, () => {
    console.log("");
    console.log("=================================");
    console.log("       ASTRO ONLINE SERVER");
    console.log("=================================");
    console.log(`Сайт запущен: http://localhost:${PORT}`);
    console.log(`Порт: ${PORT}`);
    console.log("Авторизация отключена.");
    console.log("Данные сохраняются в data.json");
    console.log("=================================");
    console.log("");
});
```

**Важно:** установи зависимости:

```bash
npm install express socket.io
```

И запускай:

```bash
node server.js
```

После первого запуска сервер сам создаст `data.json`.
