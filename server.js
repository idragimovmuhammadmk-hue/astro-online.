// Новый server.js

```js
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;

const HOST = "0.0.0.0";

/*
========================================================
 ASTRO ONLINE
 SERVER WITHOUT EXPRESS / SOCKET.IO / DATABASE
========================================================

 Запуск:

   node server.js

 Потом открыть:

   http://localhost:3000

 Никаких npm install не требуется.
 Никакого data.json не требуется.
*/

/* ======================================================
   IN-MEMORY DATABASE
====================================================== */

const users = new Map();
const ranks = new Map();
const quests = new Map();
const sessions = new Map();

/* ======================================================
   ADMIN
====================================================== */

const ADMIN_EMAIL = "admin@astro.local";
const ADMIN_PASSWORD = "admin123";

/* ======================================================
   HELPERS
====================================================== */

function id() {
    return crypto.randomUUID();
}

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(String(password))
        .digest("hex");
}

function createToken() {
    return crypto.randomBytes(32).toString("hex");
}

function json(res, status, data) {
    const body = JSON.stringify(data);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    });

    res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
    });

    res.end(body);
}

function error(res, status, message) {
    return json(res, status, {
        error: message
    });
}

function getBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";

        req.on("data", chunk => {
            body += chunk;

            if (body.length > 2 * 1024 * 1024) {
                reject(new Error("Слишком большой запрос"));
                req.destroy();
            }
        });

        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Неверный JSON"));
            }
        });

        req.on("error", reject);
    });
}

function cleanString(value, max = 100) {
    return String(value ?? "")
        .trim()
        .slice(0, max);
}

function number(value, fallback = 0) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return fallback;
    }

    return n;
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        elo: user.elo,
        xp: user.xp,
        wins: user.wins,
        rankId: user.rankId,
        ownedRanks: [...user.ownedRanks],
        claimedQuests: [...user.claimedQuests],
        isAdmin: user.isAdmin
    };
}

function publicRank(rank) {
    return {
        id: rank.id,
        rankId: rank.rankId,
        name: rank.name,
        title: rank.title,
        price: rank.price,
        color: rank.color,
        icon: rank.icon
    };
}

function publicQuest(quest) {
    return {
        id: quest.id,
        questId: quest.questId,
        title: quest.title,
        description: quest.description,
        reward: quest.reward,
        xp: quest.xp
    };
}

/* ======================================================
   DEFAULT DATA
====================================================== */

function createDefaultData() {

    const admin = {
        id: id(),
        username: "Admin",
        email: ADMIN_EMAIL,
        password: hashPassword(ADMIN_PASSWORD),

        balance: 999999999,
        elo: 9999,
        xp: 999999,
        wins: 999,

        rankId: "admin",
        ownedRanks: ["admin"],

        claimedQuests: [],

        isAdmin: true
    };

    users.set(admin.id, admin);

    const defaultRanks = [
        {
            id: id(),
            rankId: "bronze",
            name: "BRONZE",
            title: "Бронзовый",
            price: 500,
            color: "#cd7f32",
            icon: "🥉"
        },
        {
            id: id(),
            rankId: "silver",
            name: "SILVER",
            title: "Серебряный",
            price: 1500,
            color: "#c0c0c0",
            icon: "🥈"
        },
        {
            id: id(),
            rankId: "gold",
            name: "GOLD",
            title: "Золотой",
            price: 5000,
            color: "#ffd700",
            icon: "🥇"
        },
        {
            id: id(),
            rankId: "diamond",
            name: "DIAMOND",
            title: "Алмазный",
            price: 15000,
            color: "#55ddff",
            icon: "💎"
        },
        {
            id: id(),
            rankId: "legend",
            name: "LEGEND",
            title: "Легендарный",
            price: 50000,
            color: "#ff4fd8",
            icon: "👑"
        }
    ];

    for (const rank of defaultRanks) {
        ranks.set(rank.rankId, rank);
    }

    const defaultQuests = [
        {
            id: id(),
            questId: "first-win",
            title: "Первая победа",
            description: "Получите свою первую победу.",
            reward: 500,
            xp: 100
        },
        {
            id: id(),
            questId: "elo-hunter",
            title: "Охотник за ELO",
            description: "Поднимите свой рейтинг.",
            reward: 1000,
            xp: 250
        }
    ];

    for (const quest of defaultQuests) {
        quests.set(quest.questId, quest);
    }
}

createDefaultData();

/* ======================================================
   AUTH
====================================================== */

function getToken(req) {

    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
        return null;
    }

    return header.slice(7).trim() || null;
}

function getUser(req) {

    const token = getToken(req);

    if (!token) {
        return null;
    }

    const userId = sessions.get(token);

    if (!userId) {
        return null;
    }

    return users.get(userId) || null;
}

function requireAuth(req, res) {

    const user = getUser(req);

    if (!user) {
        error(res, 401, "Необходимо войти в аккаунт");
        return null;
    }

    return user;
}

function requireAdmin(req, res) {

    const user = requireAuth(req, res);

    if (!user) {
        return null;
    }

    if (!user.isAdmin) {
        error(res, 403, "Доступ только для администратора");
        return null;
    }

    return user;
}

/* ======================================================
   ROUTER
====================================================== */

async function handleApi(req, res, pathname, query) {

    /* ---------------- LOGIN ---------------- */

    if (req.method === "POST" && pathname === "/api/login") {

        let body;

        try {
            body = await getBody(req);
        } catch {
            return error(res, 400, "Неверный JSON");
        }

        const email = cleanString(body.email, 200).toLowerCase();
        const password = String(body.password ?? "");

        if (!email || !password) {
            return error(res, 400, "Введите email и пароль");
        }

        let user = null;

        for (const candidate of users.values()) {

            if (candidate.email.toLowerCase() === email) {
                user = candidate;
                break;
            }
        }

        if (!user) {
            return error(res, 401, "Неверный email или пароль");
        }

        if (user.password !== hashPassword(password)) {
            return error(res, 401, "Неверный email или пароль");
        }

        const token = createToken();

        sessions.set(token, user.id);

        return json(res, 200, {
            success: true,
            token,
            user: publicUser(user)
        });
    }

    /* ---------------- REGISTER ---------------- */

    if (req.method === "POST" && pathname === "/api/register") {

        let body;

        try {
            body = await getBody(req);
        } catch {
            return error(res, 400, "Неверный JSON");
        }

        const username = cleanString(body.username, 30);
        const email = cleanString(body.email, 200).toLowerCase();
        const password = String(body.password ?? "");

        if (username.length < 2) {
            return error(res, 400, "Никнейм слишком короткий");
        }

        if (!email.includes("@")) {
            return error(res, 400, "Введите правильный email");
        }

        if (password.length < 4) {
            return error(res, 400, "Пароль должен содержать минимум 4 символа");
        }

        for (const user of users.values()) {

            if (user.email.toLowerCase() === email) {
                return error(res, 409, "Этот email уже зарегистрирован");
            }

            if (user.username.toLowerCase() === username.toLowerCase()) {
                return error(res, 409, "Этот никнейм уже занят");
            }
        }

        const user = {
            id: id(),
            username,
            email,
            password: hashPassword(password),

            balance: 1000,
            elo: 1000,
            xp: 0,
            wins: 0,

            rankId: "bronze",
            ownedRanks: [],

            claimedQuests: [],

            isAdmin: false
        };

        users.set(user.id, user);

        const token = createToken();

        sessions.set(token, user.id);

        return json(res, 201, {
            success: true,
            token,
            user: publicUser(user)
        });
    }

    /* ---------------- LOGOUT ---------------- */

    if (req.method === "POST" && pathname === "/api/logout") {

        const token = getToken(req);

        if (token) {
            sessions.delete(token);
        }

        return json(res, 200, {
            success: true
        });
    }

    /* ---------------- ME ---------------- */

    if (req.method === "GET" && pathname === "/api/me") {

        const user = requireAuth(req, res);

        if (!user) {
            return;
        }

        return json(res, 200, {
            user: publicUser(user)
        });
    }

    /* ---------------- RANKS ---------------- */

    if (req.method === "GET" && pathname === "/api/ranks") {

        return json(res, 200, {
            ranks: [...ranks.values()].map(publicRank)
        });
    }

    /* ---------------- BUY RANK ---------------- */

    const buyMatch =
        pathname.match(/^\/api\/ranks\/([^/]+)\/buy$/);

    if (req.method === "POST" && buyMatch) {

        const user = requireAuth(req, res);

        if (!user) {
            return;
        }

        const rankId = decodeURIComponent(buyMatch[1]);

        const rank = ranks.get(rankId);

        if (!rank) {
            return error(res, 404, "Ранг не найден");
        }

        if (user.ownedRanks.includes(rankId)) {
            return error(res, 400, "Этот ранг уже куплен");
        }

        if (user.balance < rank.price) {
            return error(res, 400, "Недостаточно денег");
        }

        user.balance -= rank.price;

        user.ownedRanks.push(rankId);

        /*
         Покупка также делает ранг текущим.
        */
        user.rankId = rankId;

        return json(res, 200, {
            success: true,
            message: "Ранг куплен",
            rank: publicRank(rank),
            user: publicUser(user)
        });
    }

    /* ---------------- SET CURRENT RANK ---------------- */

    const setRankMatch =
        pathname.match(/^\/api\/ranks\/([^/]+)\/equip$/);

    if (req.method === "POST" && setRankMatch) {

        const user = requireAuth(req, res);

        if (!user) {
            return;
        }

        const rankId = decodeURIComponent(setRankMatch[1]);

        const rank = ranks.get(rankId);

        if (!rank) {
            return error(res, 404, "Ранг не найден");
        }

        if (!user.ownedRanks.includes(rankId)) {
            return error(res, 403, "Сначала купите этот ранг");
        }

        user.rankId = rankId;

        return json(res, 200, {
            success: true,
            user: publicUser(user)
        });
    }

    /* ---------------- QUESTS ---------------- */

    if (req.method === "GET" && pathname === "/api/quests") {

        return json(res, 200, {
            quests: [...quests.values()].map(publicQuest)
        });
    }

    /* ---------------- CLAIM QUEST ---------------- */

    const claimMatch =
        pathname.match(/^\/api\/quests\/([^/]+)\/claim$/);

    if (req.method === "POST" && claimMatch) {

        const user = requireAuth(req, res);

        if (!user) {
            return;
        }

        const questId = decodeURIComponent(claimMatch[1]);

        const quest = quests.get(questId);

        if (!quest) {
            return error(res, 404, "Квест не найден");
        }

        if (user.claimedQuests.includes(questId)) {
            return error(res, 400, "Этот квест уже выполнен");
        }

        user.balance += quest.reward;
        user.xp += quest.xp;

        user.claimedQuests.push(questId);

        return json(res, 200, {
            success: true,
            reward: quest.reward,
            xp: quest.xp,
            user: publicUser(user)
        });
    }

    /* ---------------- LEADERBOARD ---------------- */

    if (req.method === "GET" && pathname === "/api/leaderboard") {

        const players = [...users.values()]
            .sort((a, b) => {

                if (b.elo !== a.elo) {
                    return b.elo - a.elo;
                }

                if (b.xp !== a.xp) {
                    return b.xp - a.xp;
                }

                return b.wins - a.wins;
            })
            .map(user => ({
                id: user.id,
                username: user.username,
                elo: user.elo,
                xp: user.xp,
                wins: user.wins,
                rankId: user.rankId
            }));

        return json(res, 200, {
            players
        });
    }

    /* ==================================================
       ADMIN
    ================================================== */

    /* ---------------- ADMIN USERS ---------------- */

    if (
        req.method === "GET" &&
        pathname === "/api/admin/users"
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        const search =
            cleanString(query.get("search") || "", 100)
                .toLowerCase();

        const result = [...users.values()]
            .filter(user => {

                if (!search) {
                    return true;
                }

                return (
                    user.username.toLowerCase().includes(search) ||
                    user.email.toLowerCase().includes(search)
                );
            })
            .map(user => ({
                id: user.id,
                username: user.username,
                email: user.email,
                balance: user.balance,
                elo: user.elo,
                xp: user.xp,
                wins: user.wins,
                rankId: user.rankId,
                isAdmin: user.isAdmin
            }));

        return json(res, 200, {
            users: result
        });
    }

    /* ---------------- ADMIN UPDATE USER ---------------- */

    const adminUserMatch =
        pathname.match(/^\/api\/admin\/users\/([^/]+)$/);

    if (
        (req.method === "PUT" || req.method === "PATCH") &&
        adminUserMatch
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        const userId = decodeURIComponent(adminUserMatch[1]);

        const user = users.get(userId);

        if (!user) {
            return error(res, 404, "Игрок не найден");
        }

        let body;

        try {
            body = await getBody(req);
        } catch {
            return error(res, 400, "Неверный JSON");
        }

        if (body.elo !== undefined) {
            user.elo = Math.max(0, Math.floor(number(body.elo)));
        }

        if (body.xp !== undefined) {
            user.xp = Math.max(0, Math.floor(number(body.xp)));
        }

        if (body.wins !== undefined) {
            user.wins = Math.max(0, Math.floor(number(body.wins)));
        }

        if (body.balance !== undefined) {
            user.balance = Math.max(
                0,
                Math.floor(number(body.balance))
            );
        }

        if (body.rankId !== undefined) {

            const rankId = cleanString(body.rankId, 100);

            if (rankId === "" || ranks.has(rankId)) {
                user.rankId = rankId;
            }
        }

        return json(res, 200, {
            success: true,
            user: publicUser(user)
        });
    }

    /* ---------------- ADMIN RANKS ---------------- */

    if (
        req.method === "GET" &&
        pathname === "/api/admin/ranks"
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        return json(res, 200, {
            ranks: [...ranks.values()].map(publicRank)
        });
    }

    if (
        req.method === "POST" &&
        pathname === "/api/admin/ranks"
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        let body;

        try {
            body = await getBody(req);
        } catch {
            return error(res, 400, "Неверный JSON");
        }

        const rankId = cleanString(body.rankId, 50);

        if (!rankId) {
            return error(res, 400, "Введите ID ранга");
        }

        if (ranks.has(rankId)) {
            return error(res, 409, "Такой ранг уже существует");
        }

        const rank = {
            id: id(),
            rankId,
            name: cleanString(body.name, 50) || rankId,
            title: cleanString(body.title, 100) || "Новый ранг",
            price: Math.max(0, Math.floor(number(body.price))),
            color: cleanString(body.color, 30) || "#9b7cff",
            icon: cleanString(body.icon, 10) || "★"
        };

        ranks.set(rankId, rank);

        return json(res, 201, {
            success: true,
            rank: publicRank(rank)
        });
    }

    const adminRankMatch =
        pathname.match(/^\/api\/admin\/ranks\/([^/]+)$/);

    if (
        req.method === "DELETE" &&
        adminRankMatch
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        const idValue =
            decodeURIComponent(adminRankMatch[1]);

        if (!ranks.has(idValue)) {
            return error(res, 404, "Ранг не найден");
        }

        /*
        Нельзя удалить текущий стартовый бронзовый ранг.
        */
        if (idValue === "bronze") {
            return error(res, 400, "Нельзя удалить стартовый ранг");
        }

        ranks.delete(idValue);

        for (const user of users.values()) {

            user.ownedRanks =
                user.ownedRanks.filter(x => x !== idValue);

            if (user.rankId === idValue) {
                user.rankId = "bronze";
            }
        }

        return json(res, 200, {
            success: true
        });
    }

    /* ---------------- ADMIN QUESTS ---------------- */

    if (
        req.method === "GET" &&
        pathname === "/api/admin/quests"
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        return json(res, 200, {
            quests: [...quests.values()].map(publicQuest)
        });
    }

    if (
        req.method === "POST" &&
        pathname === "/api/admin/quests"
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        let body;

        try {
            body = await getBody(req);
        } catch {
            return error(res, 400, "Неверный JSON");
        }

        const questId = cleanString(body.questId, 50);

        if (!questId) {
            return error(res, 400, "Введите ID квеста");
        }

        if (quests.has(questId)) {
            return error(res, 409, "Такой квест уже существует");
        }

        const quest = {
            id: id(),
            questId,
            title:
                cleanString(body.title, 100) ||
                "Новый квест",

            description:
                cleanString(body.description, 500) ||
                "Описание отсутствует",

            reward:
                Math.max(
                    0,
                    Math.floor(number(body.reward))
                ),

            xp:
                Math.max(
                    0,
                    Math.floor(number(body.xp))
                )
        };

        quests.set(questId, quest);

        return json(res, 201, {
            success: true,
            quest: publicQuest(quest)
        });
    }

    const adminQuestMatch =
        pathname.match(/^\/api\/admin\/quests\/([^/]+)$/);

    if (
        req.method === "DELETE" &&
        adminQuestMatch
    ) {

        const admin = requireAdmin(req, res);

        if (!admin) {
            return;
        }

        const questId =
            decodeURIComponent(adminQuestMatch[1]);

        if (!quests.has(questId)) {
            return error(res, 404, "Квест не найден");
        }

        quests.delete(questId);

        for (const user of users.values()) {
            user.claimedQuests =
                user.claimedQuests.filter(x => x !== questId);
        }

        return json(res, 200, {
            success: true
        });
    }

    /* ---------------- HEALTH ---------------- */

    if (
        req.method === "GET" &&
        pathname === "/api/health"
    ) {

        return json(res, 200, {
            ok: true,
            server: "ASTRO ONLINE",
            users: users.size,
            ranks: ranks.size,
            quests: quests.size
        });
    }

    return error(res, 404, "API маршрут не найден");
}

/* ======================================================
   STATIC FILES
====================================================== */

function serveIndex(res) {

    const file = path.join(__dirname, "index.html");

    if (!fs.existsSync(file)) {

        return text(
            res,
            404,
            "index.html не найден. Положи index.html рядом с server.js."
        );
    }

    const html = fs.readFileSync(file);

    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": html.length,
        "Cache-Control": "no-cache"
    });

    res.end(html);
}

function serveStatic(res, pathname) {

    if (pathname === "/" || pathname === "/index.html") {
        return serveIndex(res);
    }

    /*
    Разрешаем только несколько безопасных статических файлов.
    */

    const allowed = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
    };

    const ext = path.extname(pathname).toLowerCase();

    if (!allowed[ext]) {
        return error(res, 404, "Файл не найден");
    }

    const safePath =
        path.normalize(
            path.join(__dirname, pathname)
        );

    if (!safePath.startsWith(__dirname)) {
        return error(res, 403, "Доступ запрещён");
    }

    if (!fs.existsSync(safePath)) {
        return error(res, 404, "Файл не найден");
    }

    try {

        const file = fs.readFileSync(safePath);

        res.writeHead(200, {
            "Content-Type": allowed[ext],
            "Content-Length": file.length,
            "Cache-Control": "no-cache"
        });

        res.end(file);

    } catch {
        error(res, 500, "Не удалось открыть файл");
    }
}

/* ======================================================
   HTTP SERVER
====================================================== */

const server = http.createServer(async (req, res) => {

    try {

        if (req.method === "OPTIONS") {

            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods":
                    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
                "Access-Control-Allow-Headers":
                    "Content-Type, Authorization"
            });

            res.end();

            return;
        }

        const parsed = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const pathname = parsed.pathname;

        if (pathname.startsWith("/api/")) {

            await handleApi(
                req,
                res,
                pathname,
                parsed.searchParams
            );

            return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {

            error(
                res,
                405,
                "Метод не поддерживается"
            );

            return;
        }

        serveStatic(res, pathname);

    } catch (err) {

        console.error("SERVER ERROR:", err);

        if (!res.headersSent) {
            error(
                res,
                500,
                "Внутренняя ошибка сервера"
            );
        } else {
            res.end();
        }
    }
});

/* ======================================================
   START
====================================================== */

server.listen(PORT, HOST, () => {

    console.log("");
    console.log("======================================");
    console.log("        ASTRO ONLINE SERVER");
    console.log("======================================");
    console.log("");
    console.log(`Сайт: http://localhost:${PORT}`);
    console.log("");
    console.log("АДМИН:");
    console.log(`Email: ${ADMIN_EMAIL}`);
    console.log(`Пароль: ${ADMIN_PASSWORD}`);
    console.log("");
    console.log("API:");
    console.log(`http://localhost:${PORT}/api/health`);
    console.log("");
    console.log("Сервер запущен.");
    console.log("======================================");
    console.log("");
});

/* ======================================================
   GRACEFUL SHUTDOWN
====================================================== */

function shutdown() {

    console.log("\nОстановка ASTRO SERVER...");

    server.close(() => {
        console.log("Сервер остановлен.");
        process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```
