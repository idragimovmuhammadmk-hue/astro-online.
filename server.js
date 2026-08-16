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

const JWT_SECRET =
    process.env.JWT_SECRET ||
    "change-this-secret";

const ADMIN_EMAIL =
    String(process.env.ADMIN_EMAIL || "")
        .trim()
        .toLowerCase();

const ADMIN_PASSWORD =
    String(process.env.ADMIN_PASSWORD || "");


if (!DATABASE_URL) {
    console.error(
        "DATABASE_URL is missing."
    );
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn(
        "ADMIN_EMAIL or ADMIN_PASSWORD is missing."
    );
}


const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl:
        DATABASE_URL &&
        /localhost|127\.0\.0\.1/.test(
            DATABASE_URL
        )
        ? false
        : {
            rejectUnauthorized: false
        }
});


app.use(
    express.json({
        limit: "1mb"
    })
);

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


/* =========================
   DATABASE
========================= */

async function init(){

    await pool.query(
        "CREATE EXTENSION IF NOT EXISTS pgcrypto"
    );


    await pool.query(`
        CREATE TABLE IF NOT EXISTS users(

            id UUID PRIMARY KEY,

            email TEXT UNIQUE NOT NULL,

            username TEXT UNIQUE NOT NULL,

            password_hash TEXT NOT NULL,

            balance BIGINT NOT NULL DEFAULT 1000,

            xp BIGINT NOT NULL DEFAULT 0,

            elo BIGINT NOT NULL DEFAULT 1000,

            wins BIGINT NOT NULL DEFAULT 0,

            owned_ranks JSONB NOT NULL DEFAULT '[]',

            claimed_quests JSONB NOT NULL DEFAULT '{}',

            history JSONB NOT NULL DEFAULT '[]',

            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

            last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()

        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS ranks(

            id TEXT PRIMARY KEY,

            name TEXT NOT NULL,

            title TEXT NOT NULL DEFAULT '',

            price BIGINT NOT NULL DEFAULT 0,

            color TEXT NOT NULL DEFAULT '#8b5cf6',

            icon TEXT NOT NULL DEFAULT '◆',

            created_at TIMESTAMPTZ NOT NULL DEFAULT now()

        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS quests(

            id TEXT PRIMARY KEY,

            title TEXT NOT NULL,

            description TEXT NOT NULL DEFAULT '',

            reward BIGINT NOT NULL DEFAULT 0,

            xp BIGINT NOT NULL DEFAULT 0,

            created_at TIMESTAMPTZ NOT NULL DEFAULT now()

        )
    `);


    const ranksCount =
        await pool.query(
            "SELECT COUNT(*)::int AS count FROM ranks"
        );


    if (
        ranksCount.rows[0].count === 0
    ){

        await pool.query(`
            INSERT INTO ranks
            (id,name,title,price,color,icon)
            VALUES

            ('bronze','BRONZE','Бронзовый',5000,'#cd7f32','◆'),

            ('silver','SILVER','Серебряный',15000,'#b9c3d0','◇'),

            ('gold','GOLD','Золотой',35000,'#ffd45a','✦'),

            ('diamond','DIAMOND','Алмазный',75000,'#6ee7ff','✧'),

            ('master','MASTER','Мастер',150000,'#c084fc','✹'),

            ('astro','ASTRO','ASTRO ELITE',300000,'#ff6bd6','★')

            ON CONFLICT (id)
            DO NOTHING
        `);

    }


    const questsCount =
        await pool.query(
            "SELECT COUNT(*)::int AS count FROM quests"
        );


    if (
        questsCount.rows[0].count === 0
    ){

        await pool.query(`
            INSERT INTO quests
            (id,title,description,reward,xp)
            VALUES

            (
                'daily-login',
                'Войти в систему',
                'Открой профиль и получи награду.',
                50,
                25
            ),

            (
                'daily-explore',
                'Исследователь',
                'Посети разделы ASTRO.',
                100,
                50
            ),

            (
                'daily-elite',
                'Elite Protocol',
                'Выполни специальное задание.',
                250,
                100
            )

            ON CONFLICT (id)
            DO NOTHING
        `);

    }


    console.log(
        "ASTRO database ready"
    );
}


/* =========================
   HELPERS
========================= */

function publicUser(user){

    return {

        id: user.id,

        email: user.email,

        username: user.username,

        balance: Number(
            user.balance
        ),

        xp: Number(
            user.xp
        ),

        elo: Number(
            user.elo
        ),

        wins: Number(
            user.wins
        ),

        ownedRanks:
            user.owned_ranks || [],

        claimedQuests:
            user.claimed_quests || {},

        history:
            user.history || [],

        createdAt:
            user.created_at,

        lastLoginAt:
            user.last_login_at

    };

}


function userToken(user){

    return jwt.sign(
        {
            id: user.id
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );

}


function adminToken(){

    return jwt.sign(
        {
            admin: true
        },
        JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );

}


async function auth(
    req,
    res,
    next
){

    try{

        const header =
            req.headers.authorization || "";

        if(
            !header.startsWith(
                "Bearer "
            )
        ){

            return res
                .status(401)
                .json({
                    error:
                        "Требуется вход."
                });

        }


        const token =
            header.slice(7);

        const payload =
            jwt.verify(
                token,
                JWT_SECRET
            );


        const result =
            await pool.query(
                "SELECT * FROM users WHERE id=$1",
                [payload.id]
            );


        if(
            !result.rows[0]
        ){

            throw new Error(
                "User not found"
            );

        }


        req.user =
            result.rows[0];

        next();

    }catch(error){

        return res
            .status(401)
            .json({
                error:
                    "Сессия недействительна."
            });

    }

}


async function adminAuth(
    req,
    res,
    next
){

    try{

        const header =
            req.headers.authorization || "";

        if(
            !header.startsWith(
                "Bearer "
            )
        ){

            return res
                .status(401)
                .json({
                    error:
                        "Требуется вход администратора."
                });

        }


        const token =
            header.slice(7);

        const payload =
            jwt.verify(
                token,
                JWT_SECRET
            );


        if(
            payload.admin !== true
        ){

            throw new Error(
                "Not admin"
            );

        }


        req.admin = true;

        next();

    }catch(error){

        return res
            .status(401)
            .json({
                error:
                    "Нет доступа к админке."
            });

    }

}


function broadcast(){

    io.emit(
        "leaderboard:update"
    );

}


function cleanText(
    value,
    max=100
){

    return String(
        value ?? ""
    )
    .trim()
    .slice(0,max);

}


/* =========================
   AUTH
========================= */

app.get(
    "/api/me",
    auth,
    (req,res)=>{

        res.json({
            user:
                publicUser(
                    req.user
                )
        });

    }
);


app.post(
    "/api/register",
    async(req,res)=>{

        try{

            const username =
                cleanText(
                    req.body?.username,
                    20
                );

            const email =
                cleanText(
                    req.body?.email,
                    120
                ).toLowerCase();

            const password =
                String(
                    req.body?.password || ""
                );


            if(
                !/^\S+@\S+\.\S+$/.test(
                    email
                )
            ){

                return res
                    .status(400)
                    .json({
                        error:
                            "Введите корректный email."
                    });

            }


            if(
                !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/
                    .test(username)
            ){

                return res
                    .status(400)
                    .json({
                        error:
                            "Никнейм: 3–20 символов."
                    });

            }


            if(
                password.length < 8
            ){

                return res
                    .status(400)
                    .json({
                        error:
                            "Пароль должен содержать минимум 8 символов."
                    });

            }


            const exists =
                await pool.query(
                    `
                    SELECT 1
                    FROM users
                    WHERE lower(email)=lower($1)
                    OR lower(username)=lower($2)
                    `,
                    [
                        email,
                        username
                    ]
                );


            if(
                exists.rowCount
            ){

                return res
                    .status(409)
                    .json({
                        error:
                            "Email или никнейм уже занят."
                    });

            }


            const hash =
                await bcrypt.hash(
                    password,
                    12
                );


            const result =
                await pool.query(
                    `
                    INSERT INTO users
                    (
                        id,
                        email,
                        username,
                        password_hash
                    )

                    VALUES
                    (
                        gen_random_uuid(),
                        $1,
                        $2,
                        $3
                    )

                    RETURNING *
                    `,
                    [
                        email,
                        username,
                        hash
                    ]
                );


            const user =
                result.rows[0];


            broadcast();


            res.json({

                token:
                    userToken(user),

                user:
                    publicUser(user)

            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Не удалось создать аккаунт."
                });

        }

    }
);


app.post(
    "/api/login",
    async(req,res)=>{

        try{

            const email =
                cleanText(
                    req.body?.email,
                    120
                ).toLowerCase();

            const password =
                String(
                    req.body?.password || ""
                );


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE lower(email)=lower($1)
                    `,
                    [email]
                );


            const user =
                result.rows[0];


            if(
                !user ||
                !await bcrypt.compare(
                    password,
                    user.password_hash
                )
            ){

                return res
                    .status(401)
                    .json({
                        error:
                            "Неверный email или пароль."
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
                (
                    await pool.query(
                        "SELECT * FROM users WHERE id=$1",
                        [user.id]
                    )
                ).rows[0];


            res.json({

                token:
                    userToken(fresh),

                user:
                    publicUser(fresh)

            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Ошибка входа."
                });

        }

    }
);


/* =========================
   ADMIN LOGIN
========================= */

app.post(
    "/api/admin/login",
    async(req,res)=>{

        try{

            const email =
                cleanText(
                    req.body?.email,
                    120
                ).toLowerCase();

            const password =
                String(
                    req.body?.password || ""
                );


            if(
                !ADMIN_EMAIL ||
                !ADMIN_PASSWORD
            ){

                return res
                    .status(500)
                    .json({
                        error:
                            "Администратор не настроен в Environment."
                    });

            }


            if(
                email !== ADMIN_EMAIL ||
                password !== ADMIN_PASSWORD
            ){

                return res
                    .status(401)
                    .json({
                        error:
                            "Неверные данные администратора."
                    });

            }


            res.json({

                token:
                    adminToken(),

                admin: true

            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Ошибка входа администратора."
                });

        }

    }
);


/* =========================
   PROFILE
========================= */

app.put(
    "/api/profile",
    auth,
    async(req,res)=>{

        try{

            const username =
                cleanText(
                    req.body?.username,
                    20
                );


            if(
                !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/
                    .test(username)
            ){

                return res
                    .status(400)
                    .json({
                        error:
                            "Никнейм: 3–20 символов."
                    });

            }


            const duplicate =
                await pool.query(
                    `
                    SELECT 1
                    FROM users
                    WHERE lower(username)=lower($1)
                    AND id<>$2
                    `,
                    [
                        username,
                        req.user.id
                    ]
                );


            if(
                duplicate.rowCount
            ){

                return res
                    .status(409)
                    .json({
                        error:
                            "Такой никнейм уже занят."
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


            broadcast();


            res.json({
                user:
                    publicUser(
                        result.rows[0]
                    )
            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Не удалось сохранить профиль."
                });

        }

    }
);


/* =========================
   RATING
========================= */

app.get(
    "/api/leaderboard",
    async(req,res)=>{

        try{

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

                    ORDER BY
                        elo DESC,
                        xp DESC,
                        wins DESC
                    `
                );


            res.json({

                players:
                    result.rows.map(
                        user=>({

                            id:user.id,

                            username:user.username,

                            elo:Number(
                                user.elo
                            ),

                            xp:Number(
                                user.xp
                            ),

                            wins:Number(
                                user.wins
                            ),

                            ownedRanks:
                                user.owned_ranks || []

                        })
                    )

            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Ошибка рейтинга."
                });

        }

    }
);


/* =========================
   PUBLIC RANKS
========================= */

app.get(
    "/api/ranks",
    async(req,res)=>{

        try{

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM ranks
                    ORDER BY price ASC
                    `
                );


            res.json({
                ranks:
                    result.rows.map(
                        rank=>({
                            id:rank.id,
                            name:rank.name,
                            title:rank.title,
                            price:Number(rank.price),
                            color:rank.color,
                            icon:rank.icon
                        })
                    )
            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Ошибка загрузки рангов."
                });

        }

    }
);


/* =========================
   BUY RANK
========================= */

app.post(
    "/api/ranks/:id/buy",
    auth,
    async(req,res)=>{

        const connection =
            await pool.connect();

        try{

            await connection.query(
                "BEGIN"
            );


            const rankResult =
                await connection.query(
                    `
                    SELECT *
                    FROM ranks
                    WHERE id=$1
                    `,
                    [req.params.id]
                );


            const rank =
                rankResult.rows[0];


            if(!rank){

                throw new Error(
                    "Ранг не найден."
                );

            }


            const userResult =
                await connection.query(
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
                ? [...user.owned_ranks]
                : [];


            if(
                owned.includes(
                    rank.id
                )
            ){

                throw new Error(
                    "Этот ранг уже куплен."
                );

            }


            if(
                Number(user.balance) <
                Number(rank.price)
            ){

                throw new Error(
                    "Недостаточно денег."
                );

            }


            owned.push(
                rank.id
            );


            const history =
                [
                    ...(user.history || []),

                    {
                        title:
                            `Покупка ранга · ${rank.name}`,

                        amount:
                            -Number(rank.price),

                        createdAt:
                            new Date().toISOString()
                    }

                ].slice(-50);


            const updated =
                await connection.query(
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
                        Number(rank.price),

                        JSON.stringify(
                            owned
                        ),

                        JSON.stringify(
                            history
                        ),

                        user.id
                    ]
                );


            await connection.query(
                "COMMIT"
            );


            broadcast();


            res.json({

                user:
                    publicUser(
                        updated.rows[0]
                    ),

                rank

            });


        }catch(error){

            await connection.query(
                "ROLLBACK"
            );

            res
                .status(400)
                .json({
                    error:
                        error.message
                });

        }finally{

            connection.release();

        }

    }
);


/* =========================
   PUBLIC QUESTS
========================= */

app.get(
    "/api/quests",
    async(req,res)=>{

        try{

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
                        quest=>({

                            id:quest.id,

                            title:quest.title,

                            description:
                                quest.description,

                            reward:Number(
                                quest.reward
                            ),

                            xp:Number(
                                quest.xp
                            )

                        })
                    )

            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Ошибка загрузки квестов."
                });

        }

    }
);


/* =========================
   CLAIM QUEST
========================= */

app.post(
    "/api/quests/:id/claim",
    auth,
    async(req,res)=>{

        const connection =
            await pool.connect();

        try{

            await connection.query(
                "BEGIN"
            );


            const questResult =
                await connection.query(
                    `
                    SELECT *
                    FROM quests
                    WHERE id=$1
                    `,
                    [req.params.id]
                );


            const quest =
                questResult.rows[0];


            if(!quest){

                throw new Error(
                    "Квест не найден."
                );

            }


            const userResult =
                await connection.query(
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
                {
                    ...(user.claimed_quests || {})
                };


            if(
                claimed[quest.id]
            ){

                throw new Error(
                    "Этот квест уже получен."
                );

            }


            claimed[quest.id]=true;


            const history =
                [
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
                await connection.query(
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


            await connection.query(
                "COMMIT"
            );


            broadcast();


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


        }catch(error){

            await connection.query(
                "ROLLBACK"
            );

            res
                .status(400)
                .json({
                    error:
                        error.message
                });

        }finally{

            connection.release();

        }

    }
);


/* =========================================================
   ADMIN
========================================================= */


/* ADMIN USERS */

app.get(
    "/api/admin/users",
    adminAuth,
    async(req,res)=>{

        try{

            const result =
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
                        created_at
                    FROM users

                    ORDER BY
                        elo DESC,
                        xp DESC
                    `
                );


            res.json({

                users:
                    result.rows.map(
                        user=>({

                            id:user.id,

                            email:user.email,

                            username:
                                user.username,

                            balance:Number(
                                user.balance
                            ),

                            xp:Number(
                                user.xp
                            ),

                            elo:Number(
                                user.elo
                            ),

                            wins:Number(
                                user.wins
                            ),

                            ownedRanks:
                                user.owned_ranks || [],

                            createdAt:
                                user.created_at

                        })
                    )

            });


        }catch(error){

            console.error(error);

            res
                .status(500)
                .json({
                    error:
                        "Ошибка игроков."
                });

        }

    }
);


/* ADMIN CHANGE USER */

app.patch(
    "/api/admin/users/:id",
    adminAuth,
    async(req,res)=>{

        const connection =
            await pool.connect();

        try{

            await connection.query(
                "BEGIN"
            );


            const userResult =
                await connection.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id=$1
                    FOR UPDATE
                    `,
                    [req.params.id]
                );


            const user =
                userResult.rows[0];


            if(!user){

                throw new Error(
                    "Игрок не найден."
                );

            }


            let wins =
                Number(user.wins);


            if(
                req.body.wins !== undefined
            ){

                wins =
                    Math.max(
                        0,
                        Math.floor(
                            Number(
                                req.body.wins
                            )
                        )
                    );

            }


            const balanceDelta =
                Number(
                    req.body.balanceDelta || 0
                );


            let owned =
                Array.isArray(
                    user.owned_ranks
                )
                ? [...user.owned_ranks]
                : [];


            if(
                req.body.rankId
            ){

                const rankResult =
                    await connection.query(
                        `
                        SELECT id
                        FROM ranks
                        WHERE id=$1
                        `,
                        [req.body.rankId]
                    );


                if(
                    !rankResult.rows[0]
                ){

                    throw new Error(
                        "Ранг не найден."
                    );

                }


                if(
                    !owned.includes(
                        req.body.rankId
                    )
                ){

                    owned.push(
                        req.body.rankId
                    );

                }

            }


            const history =
                [
                    ...(user.history || [])
                ];


            if(
                balanceDelta !== 0
            ){

                history.push({

                    title:
                        "Изменение баланса администратором",

                    amount:
                        balanceDelta,

                    createdAt:
                        new Date().toISOString()

                });

            }


            const updated =
                await connection.query(
                    `
                    UPDATE users

                    SET

                        wins=$1,

                        balance=GREATEST(
                            0,
                            balance+$2
                        ),

                        owned_ranks=$3,

                        history=$4

                    WHERE id=$5

                    RETURNING *
                    `,
                    [
                        wins,

                        balanceDelta,

                        JSON.stringify(
                            owned
                        ),

                        JSON.stringify(
                            history.slice(-50)
                        ),

                        user.id
                    ]
                );


            await connection.query(
                "COMMIT"
            );


            broadcast();


            res.json({

                user:
                    publicUser(
                        updated.rows[0]
                    )

            });


        }catch(error){

            await connection.query(
                "ROLLBACK"
            );

            res
                .status(400)
                .json({
                    error:
                        error.message
                });

        }finally{

            connection.release();

        }

    }
);


/* ADMIN RANKS */

app.get(
    "/api/admin/ranks",
    adminAuth,
    async(req,res)=>{

        const result =
            await pool.query(
                `
                SELECT *
                FROM ranks
                ORDER BY price ASC
                `
            );


        res.json({
            ranks:
                result.rows.map(
                    rank=>({

                        id:rank.id,

                        name:rank.name,

                        title:rank.title,

                        price:Number(
                            rank.price
                        ),

                        color:rank.color,

                        icon:rank.icon

                    })
                )
        });

    }
);


app.post(
    "/api/admin/ranks",
    adminAuth,
    async(req,res)=>{

        try{

            const id =
                cleanText(
                    req.body?.id,
                    40
                ).toLowerCase();


            const name =
                cleanText(
                    req.body?.name,
                    40
                );


            const title =
                cleanText(
                    req.body?.title,
                    100
                );


            const price =
                Math.max(
                    0,
                    Math.floor(
                        Number(
                            req.body?.price || 0
                        )
                    )
                );


            if(!id || !name){

                return res
                    .status(400)
                    .json({
                        error:
                            "ID и название обязательны."
                    });

            }


            await pool.query(
                `
                INSERT INTO ranks
                (
                    id,
                    name,
                    title,
                    price
                )

                VALUES
                ($1,$2,$3,$4)
                `,
                [
                    id,
                    name,
                    title,
                    price
                ]
            );


            res.json({
                ok:true
            });


        }catch(error){

            console.error(error);

            res
                .status(400)
                .json({
                    error:
                        "Не удалось создать ранг."
                });

        }

    }
);


app.delete(
    "/api/admin/ranks/:id",
    adminAuth,
    async(req,res)=>{

        try{

            await pool.query(
                `
                DELETE FROM ranks
                WHERE id=$1
                `,
                [req.params.id]
            );


            res.json({
                ok:true
            });


        }catch(error){

            res
                .status(500)
                .json({
                    error:
                        "Не удалось удалить ранг."
                });

        }

    }
);


/* ADMIN QUESTS */

app.get(
    "/api/admin/quests",
    adminAuth,
    async(req,res)=>{

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
                    quest=>({

                        id:quest.id,

                        title:quest.title,

                        description:
                            quest.description,

                        reward:Number(
                            quest.reward
                        ),

                        xp:Number(
                            quest.xp
                        )

                    })
                )

        });

    }
);


app.post(
    "/api/admin/quests",
    adminAuth,
    async(req,res)=>{

        try{

            const id =
                cleanText(
                    req.body?.id,
                    50
                ).toLowerCase();


            const title =
                cleanText(
                    req.body?.title,
                    100
                );


            const description =
                cleanText(
                    req.body?.description,
                    300
                );


            const reward =
                Math.max(
                    0,
                    Math.floor(
                        Number(
                            req.body?.reward || 0
                        )
                    )
                );


            const xp =
                Math.max(
                    0,
                    Math.floor(
                        Number(
                            req.body?.xp || 0
                        )
                    )
                );


            if(!id || !title){

                return res
                    .status(400)
                    .json({
                        error:
                            "ID и название обязательны."
                    });

            }


            await pool.query(
                `
                INSERT INTO quests
                (
                    id,
                    title,
                    description,
                    reward,
                    xp
                )

                VALUES
                ($1,$2,$3,$4,$5)
                `,
                [
                    id,
                    title,
                    description,
                    reward,
                    xp
                ]
            );


            res.json({
                ok:true
            });


        }catch(error){

            console.error(error);

            res
                .status(400)
                .json({
                    error:
                        "Не удалось создать квест."
                });

        }

    }
);


app.delete(
    "/api/admin/quests/:id",
    adminAuth,
    async(req,res)=>{

        try{

            await pool.query(
                `
                DELETE FROM quests
                WHERE id=$1
                `,
                [req.params.id]
            );


            res.json({
                ok:true
            });


        }catch(error){

            res
                .status(500)
                .json({
                    error:
                        "Не удалось удалить квест."
                });

        }

    }
);


/* =========================
   HEALTH CHECK
========================= */

app.get(
    "/health",
    async(req,res)=>{

        try{

            await pool.query(
                "SELECT 1"
            );

            res.json({
                ok:true,
                service:"ASTRO ONLINE"
            });

        }catch(error){

            res
                .status(500)
                .json({
                    ok:false
                });

        }

    }
);


/* =========================
   FRONTEND FALLBACK
========================= */

app.get(
    /.*/,
    (req,res)=>{

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );

    }
);


/* =========================
   START
========================= */

init()
.then(()=>{

    server.listen(
        PORT,
        "0.0.0.0",
        ()=>{
            console.log(
                `ASTRO ONLINE listening on ${PORT}`
            );
        }
    );

})
.catch(error=>{

    console.error(
        "ASTRO START ERROR:",
        error
    );

    process.exit(1);

});
