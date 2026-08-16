const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const DATA_FILE = path.join(ROOT, "data.json");

/* =========================
   НАСТРОЙКИ АДМИНА
========================= */

const ADMIN_EMAIL = "admin@astro.online";
const ADMIN_PASSWORD = "12345678";

/* =========================
   БАЗА
========================= */

function defaultDatabase() {
    return {
        users: [],
        ranks: [
            {
                id: "bronze",
                rankId: "bronze",
                name: "BRONZE",
                title: "Бронзовый",
                price: 0,
                color: "#cd7f32",
                icon: "🥉"
            },
            {
                id: "silver",
                rankId: "silver",
                name: "SILVER",
                title: "Серебряный",
                price: 1000,
                color: "#c0c0c0",
                icon: "🥈"
            },
            {
                id: "gold",
                rankId: "gold",
                name: "GOLD",
                title: "Золотой",
                price: 5000,
                color: "#ffd700",
                icon: "🥇"
            },
            {
                id: "diamond",
                rankId: "diamond",
                name: "DIAMOND",
                title: "Алмазный",
                price: 15000,
                color: "#4deaff",
                icon: "💎"
            }
        ],
        quests: [
            {
                id: "daily-win",
                questId: "daily-win",
                title: "Победитель дня",
                description: "Получи награду за выполнение квеста.",
                reward: 100,
                xp: 50
            }
        ]
    };
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const db = defaultDatabase();
            saveDatabase(db);
            return db;
        }

        const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

        if (!db.users) db.users = [];
        if (!db.ranks) db.ranks = defaultDatabase().ranks;
        if (!db.quests) db.quests = defaultDatabase().quests;

        return db;
    } catch (error) {
        console.error("Ошибка чтения data.json:", error);

        const db = defaultDatabase();
        saveDatabase(db);

        return db;
    }
}

function saveDatabase(db) {
    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(db, null, 2),
        "utf8"
    );
}

const db = loadDatabase();

/* =========================
   ПАРОЛИ
========================= */

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(String(password))
        .digest("hex");
}

/* =========================
   ТОКЕНЫ
========================= */

const sessions = new Map();

function createToken(userId) {
    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
        userId,
        createdAt: Date.now()
    });

    return token;
}

function getToken(req) {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return null;
    }

    return auth.slice(7).trim();
}

function getCurrentUser(req) {
    const token = getToken(req);

    if (!token) return null;

    const session = sessions.get(token);

    if (!session) return null;

    return db.users.find(
        user => user.id === session.userId
    ) || null;
}

function requireAuth(req, res) {
    const user = getCurrentUser(req);

    if (!user) {
        sendJson(res, 401, {
            error: "Необходима авторизация"
        });

        return null;
    }

    return user;
}

function requireAdmin(req, res) {
    const user = requireAuth(req, res);

    if (!user) return null;

    if (!user.isAdmin) {
        sendJson(res, 403, {
            error: "Доступ запрещён. Нужны права администратора."
        });

        return null;
    }

    return user;
}

/* =========================
   ПОЛЬЗОВАТЕЛИ
========================= */

function publicUser(user) {
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
        isAdmin: !!user.isAdmin
    };
}

function findUserByEmail(email) {
    return db.users.find(
        user =>
            user.email.toLowerCase() ===
            String(email).trim().toLowerCase()
    );
}

function findUserByUsername(username) {
    return db.users.find(
        user =>
            user.username.toLowerCase() ===
            String(username).trim().toLowerCase()
    );
}

/* =========================
   HTTP
========================= */

function sendJson(res, status, data) {
    const body = JSON.stringify(data);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
    });

    res.end(body);
}

function sendText(res, status, text, contentType) {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*"
    });

    res.end(text);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";

        req.on("data", chunk => {
            body += chunk.toString();

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

function id() {
    return crypto.randomUUID();
}

/* =========================
   API
========================= */

async function handleApi(req, res, url) {

    /* ---------- REGISTER ---------- */

    if (
        req.method === "POST" &&
        url.pathname === "/api/register"
    ) {
        try {
            const body = await readBody(req);

            const username = String(body.username || "").trim();
            const email = String(body.email || "").trim();
            const password = String(body.password || "");

            if (username.length < 3) {
                return sendJson(res, 400, {
                    error: "Никнейм должен содержать минимум 3 символа"
                });
            }

            if (!email.includes("@")) {
                return sendJson(res, 400, {
                    error: "Введите правильный email"
                });
            }

            if (password.length < 6) {
                return sendJson(res, 400, {
                    error: "Пароль должен содержать минимум 6 символов"
                });
            }

            if (findUserByEmail(email)) {
                return sendJson(res, 409, {
                    error: "Такой email уже зарегистрирован"
                });
            }

            if (findUserByUsername(username)) {
                return sendJson(res, 409, {
                    error: "Такой никнейм уже существует"
                });
            }

            const user = {
                id: id(),
                username,
                email,
                password: hashPassword(password),

                balance: 10000,
                elo: 1000,
                xp: 0,
                wins: 0,

                ownedRanks: ["bronze"],
                rankId: "bronze",

                isAdmin:
                    email.toLowerCase() ===
                    ADMIN_EMAIL.toLowerCase()
            };

            db.users.push(user);
            saveDatabase(db);

            const token = createToken(user.id);

            return sendJson(res, 201, {
                ok: true,
                token,
                user: publicUser(user)
            });

        } catch (error) {
            console.error(error);

            return sendJson(res, 500, {
                error: "Ошибка регистрации"
            });
        }
    }

    /* ---------- LOGIN ---------- */

    if (
        req.method === "POST" &&
        url.pathname === "/api/login"
    ) {
        try {
            const body = await readBody(req);

            const email = String(body.email || "").trim();
            const password = String(body.password || "");

            if (!email || !password) {
                return sendJson(res, 400, {
                    error: "Введите email и пароль"
                });
            }

            let user = findUserByEmail(email);

            /*
             * Автоматически создаём администратора
             * при первом входе.
             */

            if (
                email.toLowerCase() ===
                    ADMIN_EMAIL.toLowerCase() &&
                password === ADMIN_PASSWORD
            ) {
                if (!user) {
                    user = {
                        id: id(),
                        username: "ASTRO ADMIN",
                        email: ADMIN_EMAIL,
                        password: hashPassword(ADMIN_PASSWORD),

                        balance: 999999999,
                        elo: 999999,
                        xp: 999999,
                        wins: 9999,

                        ownedRanks: [],
                        rankId: null,

                        isAdmin: true
                    };

                    db.users.push(user);
                } else {
                    user.isAdmin = true;
                    user.password = hashPassword(
                        ADMIN_PASSWORD
                    );
                }

                saveDatabase(db);

                const token = createToken(user.id);

                return sendJson(res, 200, {
                    ok: true,
                    token,
                    user: publicUser(user)
                });
            }

            if (!user) {
                return sendJson(res, 401, {
                    error: "Неверный email или пароль"
                });
            }

            if (
                user.password !==
                hashPassword(password)
            ) {
                return sendJson(res, 401, {
                    error: "Неверный email или пароль"
                });
            }

            const token = createToken(user.id);

            return sendJson(res, 200, {
                ok: true,
                token,
                user: publicUser(user)
            });

        } catch (error) {
            console.error(error);

            return sendJson(res, 500, {
                error: "Ошибка авторизации"
            });
        }
    }

    /* ---------- ME ---------- */

    if (
        req.method === "GET" &&
        url.pathname === "/api/me"
    ) {
        const user = requireAuth(req, res);

        if (!user) return;

        return sendJson(res, 200, {
            ok: true,
            user: publicUser(user)
        });
    }

    /* ---------- RANKS ---------- */

    if (
        req.method === "GET" &&
        url.pathname === "/api/ranks"
    ) {
        return sendJson(res, 200, {
            ok: true,
            ranks: db.ranks
        });
    }

    /* ---------- BUY RANK ---------- */

    const buyRankMatch =
        url.pathname.match(
            /^\/api\/ranks\/([^/]+)\/buy$/
        );

    if (
        req.method === "POST" &&
        buyRankMatch
    ) {
        const user = requireAuth(req, res);

        if (!user) return;

        const rankId =
            decodeURIComponent(buyRankMatch[1]);

        const rank = db.ranks.find(
            r =>
                r.id === rankId ||
                r.rankId === rankId
        );

        if (!rank) {
            return sendJson(res, 404, {
                error: "Ранг не найден"
            });
        }

        if (
            !Array.isArray(user.ownedRanks)
        ) {
            user.ownedRanks = [];
        }

        if (
            user.ownedRanks.includes(
                rank.id
            )
        ) {
            return sendJson(res, 400, {
                error: "Этот ранг уже куплен"
            });
        }

        const price =
            Number(rank.price) || 0;

        if (
            Number(user.balance) <
            price
        ) {
            return sendJson(res, 400, {
                error: "Недостаточно денег"
            });
        }

        user.balance =
            Number(user.balance) - price;

        user.ownedRanks.push(rank.id);
        user.rankId = rank.id;

        saveDatabase(db);

        return sendJson(res, 200, {
            ok: true,
            message: "Ранг куплен",
            user: publicUser(user)
        });
    }

    /* ---------- QUESTS ---------- */

    if (
        req.method === "GET" &&
        url.pathname === "/api/quests"
    ) {
        return sendJson(res, 200, {
            ok: true,
            quests: db.quests
        });
    }

    /* ---------- CLAIM QUEST ---------- */

    const claimQuestMatch =
        url.pathname.match(
            /^\/api\/quests\/([^/]+)\/claim$/
        );

    if (
        req.method === "POST" &&
        claimQuestMatch
    ) {
        const user = requireAuth(req, res);

        if (!user) return;

        const questId =
            decodeURIComponent(
                claimQuestMatch[1]
            );

        const quest = db.quests.find(
            q =>
                q.id === questId ||
                q.questId === questId
        );

        if (!quest) {
            return sendJson(res, 404, {
                error: "Квест не найден"
            });
        }

        user.balance =
            Number(user.balance || 0) +
            Number(quest.reward || 0);

        user.xp =
            Number(user.xp || 0) +
            Number(quest.xp || 0);

        saveDatabase(db);

        return sendJson(res, 200, {
            ok: true,
            reward: Number(quest.reward || 0),
            xp: Number(quest.xp || 0),
            user: publicUser(user)
        });
    }

    /* ---------- LEADERBOARD ---------- */

    if (
        req.method === "GET" &&
        url.pathname === "/api/leaderboard"
    ) {
        const players = db.users
            .map(publicUser)
            .sort(
                (a, b) =>
                    Number(b.elo) -
                    Number(a.elo)
            );

        return sendJson(res, 200, {
            ok: true,
            players
        });
    }

    /* =========================
       ADMIN USERS
    ========================= */

    if (
        req.method === "GET" &&
        url.pathname === "/api/admin/users"
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        const search =
            String(
                url.searchParams.get("search") ||
                ""
            )
            .trim()
            .toLowerCase();

        let users = db.users;

        if (search) {
            users = users.filter(user =>
                user.username
                    .toLowerCase()
                    .includes(search) ||
                user.email
                    .toLowerCase()
                    .includes(search)
            );
        }

        return sendJson(res, 200, {
            ok: true,
            users: users.map(publicUser)
        });
    }

    /* ---------- UPDATE USER ---------- */

    const adminUserMatch =
        url.pathname.match(
            /^\/api\/admin\/users\/([^/]+)$/
        );

    if (
        req.method === "PUT" &&
        adminUserMatch
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        const userId =
            decodeURIComponent(
                adminUserMatch[1]
            );

        const user = db.users.find(
            u => u.id === userId
        );

        if (!user) {
            return sendJson(res, 404, {
                error: "Игрок не найден"
            });
        }

        try {
            const body = await readBody(req);

            if (body.elo !== undefined) {
                user.elo =
                    Math.max(
                        0,
                        Number(body.elo) || 0
                    );
            }

            if (body.wins !== undefined) {
                user.wins =
                    Math.max(
                        0,
                        Number(body.wins) || 0
                    );
            }

            if (body.balance !== undefined) {
                user.balance =
                    Math.max(
                        0,
                        Number(body.balance) || 0
                    );
            }

            if (body.xp !== undefined) {
                user.xp =
                    Math.max(
                        0,
                        Number(body.xp) || 0
                    );
            }

            saveDatabase(db);

            return sendJson(res, 200, {
                ok: true,
                user: publicUser(user)
            });

        } catch {
            return sendJson(res, 400, {
                error: "Неверные данные"
            });
        }
    }

    /* =========================
       ADMIN RANKS
    ========================= */

    if (
        req.method === "GET" &&
        url.pathname === "/api/admin/ranks"
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        return sendJson(res, 200, {
            ok: true,
            ranks: db.ranks
        });
    }

    if (
        req.method === "POST" &&
        url.pathname === "/api/admin/ranks"
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        try {
            const body = await readBody(req);

            const rankId =
                String(body.rankId || "").trim();

            const name =
                String(body.name || "").trim();

            if (!rankId || !name) {
                return sendJson(res, 400, {
                    error: "ID и название ранга обязательны"
                });
            }

            if (
                db.ranks.some(
                    r =>
                        r.id === rankId ||
                        r.rankId === rankId
                )
            ) {
                return sendJson(res, 409, {
                    error: "Такой ранг уже существует"
                });
            }

            const rank = {
                id: rankId,
                rankId,
                name,
                title:
                    String(
                        body.title || ""
                    ).trim(),
                price:
                    Math.max(
                        0,
                        Number(body.price) || 0
                    ),
                color:
                    String(
                        body.color || "#ffffff"
                    ),
                icon:
                    String(
                        body.icon || "★"
                    )
            };

            db.ranks.push(rank);

            saveDatabase(db);

            return sendJson(res, 201, {
                ok: true,
                rank
            });

        } catch {
            return sendJson(res, 400, {
                error: "Ошибка создания ранга"
            });
        }
    }

    const adminRankMatch =
        url.pathname.match(
            /^\/api\/admin\/ranks\/([^/]+)$/
        );

    if (
        req.method === "DELETE" &&
        adminRankMatch
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        const rankId =
            decodeURIComponent(
                adminRankMatch[1]
            );

        const index =
            db.ranks.findIndex(
                r =>
                    r.id === rankId ||
                    r.rankId === rankId
            );

        if (index === -1) {
            return sendJson(res, 404, {
                error: "Ранг не найден"
            });
        }

        db.ranks.splice(index, 1);

        saveDatabase(db);

        return sendJson(res, 200, {
            ok: true
        });
    }

    /* =========================
       ADMIN QUESTS
    ========================= */

    if (
        req.method === "GET" &&
        url.pathname === "/api/admin/quests"
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        return sendJson(res, 200, {
            ok: true,
            quests: db.quests
        });
    }

    if (
        req.method === "POST" &&
        url.pathname === "/api/admin/quests"
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        try {
            const body = await readBody(req);

            const questId =
                String(body.questId || "").trim();

            if (!questId) {
                return sendJson(res, 400, {
                    error: "ID квеста обязателен"
                });
            }

            if (
                db.quests.some(
                    q =>
                        q.id === questId ||
                        q.questId === questId
                )
            ) {
                return sendJson(res, 409, {
                    error: "Такой квест уже существует"
                });
            }

            const quest = {
                id: questId,
                questId,

                title:
                    String(
                        body.title || "Новый квест"
                    ),

                description:
                    String(
                        body.description || ""
                    ),

                reward:
                    Math.max(
                        0,
                        Number(body.reward) || 0
                    ),

                xp:
                    Math.max(
                        0,
                        Number(body.xp) || 0
                    )
            };

            db.quests.push(quest);

            saveDatabase(db);

            return sendJson(res, 201, {
                ok: true,
                quest
            });

        } catch {
            return sendJson(res, 400, {
                error: "Ошибка создания квеста"
            });
        }
    }

    const adminQuestMatch =
        url.pathname.match(
            /^\/api\/admin\/quests\/([^/]+)$/
        );

    if (
        req.method === "DELETE" &&
        adminQuestMatch
    ) {
        const admin = requireAdmin(req, res);

        if (!admin) return;

        const questId =
            decodeURIComponent(
                adminQuestMatch[1]
            );

        const index =
            db.quests.findIndex(
                q =>
                    q.id === questId ||
                    q.questId === questId
            );

        if (index === -1) {
            return sendJson(res, 404, {
                error: "Квест не найден"
            });
        }

        db.quests.splice(index, 1);

        saveDatabase(db);

        return sendJson(res, 200, {
            ok: true
        });
    }

    return sendJson(res, 404, {
        error: "API маршрут не найден",
        path: url.pathname
    });
}

/* =========================
   СТАТИКА
========================= */

function serveStatic(req, res) {

    let pathname;

    try {
        pathname =
            decodeURIComponent(
                new URL(
                    req.url,
                    "http://localhost"
                ).pathname
            );
    } catch {
        return sendText(
            res,
            400,
            "Bad Request",
            "text/plain; charset=utf-8"
        );
    }

    if (pathname === "/") {
        pathname = "/index.html";
    }

    const filePath =
        path.join(
            ROOT,
            pathname
                .replace(/^[/\\]+/, "")
        );

    /*
     * Не позволяем выйти из папки проекта.
     */

    if (
        !filePath.startsWith(
            ROOT + path.sep
        ) &&
        filePath !== ROOT
    ) {
        return sendText(
            res,
            403,
            "Forbidden",
            "text/plain; charset=utf-8"
        );
    }

    if (!fs.existsSync(filePath)) {
        return sendText(
            res,
            404,
            "Файл не найден",
            "text/plain; charset=utf-8"
        );
    }

    const stat =
        fs.statSync(filePath);

    if (!stat.isFile()) {
        return sendText(
            res,
            404,
            "Файл не найден",
            "text/plain; charset=utf-8"
        );
    }

    const ext =
        path.extname(filePath)
            .toLowerCase();

    const types = {
        ".html":
            "text/html; charset=utf-8",
        ".css":
            "text/css; charset=utf-8",
        ".js":
            "application/javascript; charset=utf-8",
        ".json":
            "application/json; charset=utf-8",
        ".png":
            "image/png",
        ".jpg":
            "image/jpeg",
        ".jpeg":
            "image/jpeg",
        ".svg":
            "image/svg+xml",
        ".ico":
            "image/x-icon"
    };

    const contentType =
        types[ext] ||
        "application/octet-stream";

    res.writeHead(200, {
        "Content-Type": contentType
    });

    fs.createReadStream(filePath)
        .pipe(res);
}

/* =========================
   SERVER
========================= */

const server =
    http.createServer(
        async (req, res) => {

            console.log(
                new Date().toISOString(),
                req.method,
                req.url
            );

            if (
                req.method === "OPTIONS"
            ) {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers":
                        "Content-Type, Authorization",
                    "Access-Control-Allow-Methods":
                        "GET, POST, PUT, DELETE, OPTIONS"
                });

                res.end();

                return;
            }

            try {
                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host || "localhost"}`
                    );

                if (
                    url.pathname.startsWith(
                        "/api/"
                    )
                ) {
                    await handleApi(
                        req,
                        res,
                        url
                    );

                    return;
                }

                serveStatic(
                    req,
                    res
                );

            } catch (error) {

                console.error(
                    "SERVER ERROR:",
                    error
                );

                if (!res.headersSent) {
                    sendJson(
                        res,
                        500,
                        {
                            error:
                                "Внутренняя ошибка сервера"
                        }
                    );
                } else {
                    res.end();
                }
            }
        }
    );

server.on(
    "error",
    error => {
        console.error(
            "Ошибка сервера:",
            error
        );
    }
);

server.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log("");
        console.log(
            "================================"
        );
        console.log(
            "       ASTRO ONLINE SERVER"
        );
        console.log(
            "================================"
        );
        console.log(
            `Сайт: http://localhost:${PORT}`
        );
        console.log(
            `Админ: ${ADMIN_EMAIL}`
        );
        console.log(
            `Пароль: ${ADMIN_PASSWORD}`
        );
        console.log(
            "================================"
        );
        console.log("");
    }
);
