require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET =
  process.env.JWT_SECRET ||
  'astro-secret-change-this';

const ADMIN_EMAIL =
  process.env.ADMIN_EMAIL ||
  'admin@astro.online';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  'AstroAdmin123!';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing!');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    DATABASE_URL &&
    /localhost|127\.0\.0\.1/.test(DATABASE_URL)
      ? false
      : { rejectUnauthorized: false }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '2mb' }));

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

/* =========================
   DEFAULT RANKS
========================= */

const DEFAULT_RANKS = [
  {
    id: 'bronze',
    name: 'BRONZE',
    title: 'Бронзовый',
    price: 5000,
    color: '#cd7f32',
    icon: '◆'
  },
  {
    id: 'silver',
    name: 'SILVER',
    title: 'Серебряный',
    price: 15000,
    color: '#b9c3d0',
    icon: '◇'
  },
  {
    id: 'gold',
    name: 'GOLD',
    title: 'Золотой',
    price: 35000,
    color: '#ffd45a',
    icon: '✦'
  },
  {
    id: 'diamond',
    name: 'DIAMOND',
    title: 'Алмазный',
    price: 75000,
    color: '#6ee7ff',
    icon: '✧'
  },
  {
    id: 'master',
    name: 'MASTER',
    title: 'Мастер',
    price: 150000,
    color: '#c084fc',
    icon: '✹'
  },
  {
    id: 'astro',
    name: 'ASTRO',
    title: 'ASTRO ELITE',
    price: 300000,
    color: '#ff6bd6',
    icon: '★'
  }
];

/* =========================
   DEFAULT QUESTS
========================= */

const DEFAULT_QUESTS = [
  {
    id: 'daily-login',
    title: 'Войти в систему',
    reward: 50,
    xp: 25,
    description:
      'Открой профиль и забери ежедневную награду.'
  },
  {
    id: 'daily-explore',
    title: 'Исследователь',
    reward: 100,
    xp: 50,
    description:
      'Посети разделы ASTRO и изучи новый сезон.'
  },
  {
    id: 'daily-elite',
    title: 'Elite Protocol',
    reward: 250,
    xp: 100,
    description:
      'Выполни особое задание сезона.'
  }
];

/* =========================
   DATABASE
========================= */

async function init() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto
  `);

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
      title TEXT NOT NULL,
      price BIGINT NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#ffffff',
      icon TEXT NOT NULL DEFAULT '★'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quests(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      reward BIGINT NOT NULL DEFAULT 0,
      xp BIGINT NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT ''
    )
  `);

  /* Добавляем стандартные ранги */
  for (const rank of DEFAULT_RANKS) {
    await pool.query(
      `
      INSERT INTO ranks
      (id,name,title,price,color,icon)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO NOTHING
      `,
      [
        rank.id,
        rank.name,
        rank.title,
        rank.price,
        rank.color,
        rank.icon
      ]
    );
  }

  /* Добавляем стандартные квесты */
  for (const quest of DEFAULT_QUESTS) {
    await pool.query(
      `
      INSERT INTO quests
      (id,title,reward,xp,description)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO NOTHING
      `,
      [
        quest.id,
        quest.title,
        quest.reward,
        quest.xp,
        quest.description
      ]
    );
  }

  console.log('ASTRO database ready');
}

/* =========================
   HELPERS
========================= */

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,

    balance: Number(u.balance),
    xp: Number(u.xp),
    elo: Number(u.elo),
    wins: Number(u.wins),

    ownedRanks: u.owned_ranks || [],
    claimedQuests: u.claimed_quests || {},
    history: u.history || [],

    createdAt: u.created_at,
    lastLoginAt: u.last_login_at
  };
}

function tokenFor(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: '30d'
    }
  );
}

function broadcast() {
  io.emit('leaderboard:update');
}

/* =========================
   USER AUTH
========================= */

async function auth(req, res, next) {
  try {
    const header =
      req.headers.authorization || '';

    const token =
      header.startsWith('Bearer ')
        ? header.slice(7)
        : '';

    if (!token) {
      return res.status(401).json({
        error: 'Требуется вход.'
      });
    }

    const payload =
      jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      'SELECT * FROM users WHERE id=$1',
      [payload.id]
    );

    if (!result.rows[0]) {
      throw new Error();
    }

    req.user = result.rows[0];

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Сессия недействительна.'
    });
  }
}

/* =========================
   ADMIN AUTH
========================= */

function adminAuth(req, res, next) {
  try {
    const header =
      req.headers.authorization || '';

    const token =
      header.startsWith('Bearer ')
        ? header.slice(7)
        : '';

    if (!token) {
      return res.status(401).json({
        error: 'Требуется вход администратора.'
      });
    }

    const payload =
      jwt.verify(token, JWT_SECRET);

    if (
      payload.role !== 'admin' ||
      payload.email !== ADMIN_EMAIL
    ) {
      return res.status(403).json({
        error: 'Доступ запрещён.'
      });
    }

    req.admin = payload;

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Админская сессия недействительна.'
    });
  }
}

/* =========================
   ADMIN LOGIN
========================= */

app.post(
  '/api/admin/login',
  async (req, res) => {
    try {
      const email =
        String(req.body?.email || '')
          .trim()
          .toLowerCase();

      const password =
        String(req.body?.password || '');

      if (
        email !==
        ADMIN_EMAIL.toLowerCase()
      ) {
        return res.status(401).json({
          error:
            'Неверный email или пароль.'
        });
      }

      if (
        password !==
        ADMIN_PASSWORD
      ) {
        return res.status(401).json({
          error:
            'Неверный email или пароль.'
        });
      }

      const token =
        jwt.sign(
          {
            role: 'admin',
            email: ADMIN_EMAIL
          },
          JWT_SECRET,
          {
            expiresIn: '7d'
          }
        );

      res.json({
        token,
        admin: {
          email: ADMIN_EMAIL,
          role: 'admin'
        }
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Ошибка входа администратора.'
      });
    }
  }
);

/* =========================
   ME
========================= */

app.get(
  '/api/me',
  auth,
  (req, res) => {
    res.json({
      user: publicUser(req.user)
    });
  }
);

/* =========================
   REGISTER
========================= */

app.post(
  '/api/register',
  async (req, res) => {
    try {
      const {
        username,
        email,
        password
      } = req.body || {};

      const e =
        String(email || '')
          .trim()
          .toLowerCase();

      const n =
        String(username || '').trim();

      if (
        !/^\S+@\S+\.\S+$/.test(e)
      ) {
        return res.status(400).json({
          error:
            'Введите корректный email.'
        });
      }

      if (
        !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
          n
        )
      ) {
        return res.status(400).json({
          error:
            'Никнейм: 3–20 символов.'
        });
      }

      if (
        String(password || '').length < 8
      ) {
        return res.status(400).json({
          error:
            'Пароль должен содержать минимум 8 символов.'
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
          [e, n]
        );

      if (exists.rowCount) {
        return res.status(409).json({
          error:
            'Email или никнейм уже занят.'
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
          INSERT INTO users(
            id,
            email,
            username,
            password_hash
          )
          VALUES(
            gen_random_uuid(),
            $1,
            $2,
            $3
          )
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

      broadcast();

      res.json({
        token: tokenFor(user),
        user: publicUser(user)
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось создать аккаунт.'
      });
    }
  }
);

/* =========================
   LOGIN
========================= */

app.post(
  '/api/login',
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body || {};

      const result =
        await pool.query(
          `
          SELECT *
          FROM users
          WHERE lower(email)=lower($1)
          `,
          [
            String(email || '')
              .trim()
          ]
        );

      const user =
        result.rows[0];

      if (
        !user ||
        !(await bcrypt.compare(
          String(password || ''),
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
        (
          await pool.query(
            'SELECT * FROM users WHERE id=$1',
            [user.id]
          )
        ).rows[0];

      res.json({
        token: tokenFor(fresh),
        user: publicUser(fresh)
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'Ошибка входа.'
      });
    }
  }
);

/* =========================
   LEADERBOARD
========================= */

app.get(
  '/api/leaderboard',
  async (req, res) => {
    try {
      const users =
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

      const ranks =
        await pool.query(
          `
          SELECT *
          FROM ranks
          ORDER BY price ASC
          `
        );

      const quests =
        await pool.query(
          `
          SELECT *
          FROM quests
          `
        );

      res.json({
        players:
          users.rows.map(u => ({
            id: u.id,
            username: u.username,
            elo: Number(u.elo),
            xp: Number(u.xp),
            wins: Number(u.wins),
            ownedRanks:
              u.owned_ranks || []
          })),

        ranks: ranks.rows,

        quests: quests.rows
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Ошибка рейтинга.'
      });
    }
  }
);

/* =========================
   PROFILE
========================= */

app.put(
  '/api/profile',
  auth,
  async (req, res) => {
    try {
      const n =
        String(
          req.body?.username || ''
        ).trim();

      if (
        !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(
          n
        )
      ) {
        return res.status(400).json({
          error:
            'Никнейм: 3–20 символов.'
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
          [n, req.user.id]
        );

      if (duplicate.rowCount) {
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
            n,
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
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось сохранить профиль.'
      });
    }
  }
);

/* =========================
   BUY RANK
========================= */

app.post(
  '/api/ranks/:id/buy',
  auth,
  async (req, res) => {
    const rankResult =
      await pool.query(
        'SELECT * FROM ranks WHERE id=$1',
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

    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      const result =
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
        result.rows[0];

      const owned =
        Array.isArray(
          user.owned_ranks
        )
          ? [...user.owned_ranks]
          : [];

      if (
        owned.includes(rank.id)
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
          `Не хватает ${
            (
              Number(rank.price) -
              Number(user.balance)
            ).toLocaleString(
              'ru-RU'
            )
          } ₽`
        );
      }

      owned.push(rank.id);

      const history = [
        ...(user.history || []),
        {
          title:
            `Покупка ранга · ${rank.name}`,
          amount:
            -Number(rank.price),
          createdAt:
            new Date().toISOString()
        }
      ].slice(-30);

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
            JSON.stringify(owned),
            JSON.stringify(history),
            user.id
          ]
        );

      await connection.query(
        'COMMIT'
      );

      broadcast();

      res.json({
        user:
          publicUser(
            updated.rows[0]
          ),
        rank
      });
    } catch (error) {
      await connection.query(
        'ROLLBACK'
      );

      res.status(400).json({
        error:
          error.message
      });
    } finally {
      connection.release();
    }
  }
);

/* =========================
   CLAIM QUEST
========================= */

app.post(
  '/api/quests/:id/claim',
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        'SELECT * FROM quests WHERE id=$1',
        [req.params.id]
      );

    const quest =
      result.rows[0];

    if (!quest) {
      return res.status(404).json({
        error:
          'Квест не найден.'
      });
    }

    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      const user =
        (
          await connection.query(
            `
            SELECT *
            FROM users
            WHERE id=$1
            FOR UPDATE
            `,
            [req.user.id]
          )
        ).rows[0];

      const claimed =
        user.claimed_quests || {};

      if (
        claimed[quest.id]
      ) {
        throw new Error(
          'Этот квест уже получен.'
        );
      }

      claimed[quest.id] = true;

      const history = [
        ...(user.history || []),
        {
          title:
            `Квест · ${quest.title}`,
          amount:
            Number(quest.reward),
          createdAt:
            new Date().toISOString()
        }
      ].slice(-30);

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
            Number(quest.reward),
            Number(quest.xp),
            JSON.stringify(claimed),
            JSON.stringify(history),
            user.id
          ]
        );

      await connection.query(
        'COMMIT'
      );

      broadcast();

      res.json({
        user:
          publicUser(
            updated.rows[0]
          ),
        reward:
          Number(quest.reward),
        xp:
          Number(quest.xp)
      });
    } catch (error) {
      await connection.query(
        'ROLLBACK'
      );

      res.status(400).json({
        error:
          error.message
      });
    } finally {
      connection.release();
    }
  }
);

/* =====================================================
   ADMIN
   USERS
===================================================== */

/* Получить всех игроков */

app.get(
  '/api/admin/users',
  adminAuth,
  async (req, res) => {
    try {
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
            created_at,
            last_login_at
          FROM users
          ORDER BY created_at DESC
          `
        );

      res.json({
        users:
          result.rows.map(
            publicUser
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось загрузить игроков.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   GIVE MONEY
===================================================== */

app.post(
  '/api/admin/users/:id/money',
  adminAuth,
  async (req, res) => {
    try {
      const amount =
        Number(req.body?.amount);

      if (
        !Number.isFinite(amount)
      ) {
        return res.status(400).json({
          error:
            'Некорректная сумма.'
        });
      }

      const result =
        await pool.query(
          `
          UPDATE users
          SET balance=GREATEST(0,balance+$1)
          WHERE id=$2
          RETURNING *
          `,
          [
            Math.trunc(amount),
            req.params.id
          ]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Игрок не найден.'
        });
      }

      broadcast();

      res.json({
        user:
          publicUser(
            result.rows[0]
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось изменить баланс.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   GIVE XP
===================================================== */

app.post(
  '/api/admin/users/:id/xp',
  adminAuth,
  async (req, res) => {
    try {
      const amount =
        Number(req.body?.amount);

      if (
        !Number.isFinite(amount)
      ) {
        return res.status(400).json({
          error:
            'Некорректное количество XP.'
        });
      }

      const result =
        await pool.query(
          `
          UPDATE users
          SET xp=GREATEST(0,xp+$1)
          WHERE id=$2
          RETURNING *
          `,
          [
            Math.trunc(amount),
            req.params.id
          ]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Игрок не найден.'
        });
      }

      broadcast();

      res.json({
        user:
          publicUser(
            result.rows[0]
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось изменить XP.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   GIVE WINS
===================================================== */

app.post(
  '/api/admin/users/:id/wins',
  adminAuth,
  async (req, res) => {
    try {
      const amount =
        Number(req.body?.amount);

      if (
        !Number.isFinite(amount)
      ) {
        return res.status(400).json({
          error:
            'Некорректное количество побед.'
        });
      }

      const result =
        await pool.query(
          `
          UPDATE users
          SET wins=GREATEST(0,wins+$1)
          WHERE id=$2
          RETURNING *
          `,
          [
            Math.trunc(amount),
            req.params.id
          ]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Игрок не найден.'
        });
      }

      broadcast();

      res.json({
        user:
          publicUser(
            result.rows[0]
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось изменить победы.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   GIVE RANK
===================================================== */

app.post(
  '/api/admin/users/:id/ranks',
  adminAuth,
  async (req, res) => {
    try {
      const rankId =
        String(
          req.body?.rankId || ''
        ).trim();

      if (!rankId) {
        return res.status(400).json({
          error:
            'Не указан ранг.'
        });
      }

      const rank =
        (
          await pool.query(
            'SELECT * FROM ranks WHERE id=$1',
            [rankId]
          )
        ).rows[0];

      if (!rank) {
        return res.status(404).json({
          error:
            'Ранг не найден.'
        });
      }

      const user =
        (
          await pool.query(
            'SELECT * FROM users WHERE id=$1',
            [req.params.id]
          )
        ).rows[0];

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
          ? [...user.owned_ranks]
          : [];

      if (
        !owned.includes(rankId)
      ) {
        owned.push(rankId);
      }

      const updated =
        await pool.query(
          `
          UPDATE users
          SET owned_ranks=$1
          WHERE id=$2
          RETURNING *
          `,
          [
            JSON.stringify(owned),
            user.id
          ]
        );

      broadcast();

      res.json({
        user:
          publicUser(
            updated.rows[0]
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось выдать ранг.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   REMOVE RANK
===================================================== */

app.delete(
  '/api/admin/users/:id/ranks/:rankId',
  adminAuth,
  async (req, res) => {
    try {
      const user =
        (
          await pool.query(
            'SELECT * FROM users WHERE id=$1',
            [req.params.id]
          )
        ).rows[0];

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
          ? user.owned_ranks.filter(
              id =>
                id !==
                req.params.rankId
            )
          : [];

      const updated =
        await pool.query(
          `
          UPDATE users
          SET owned_ranks=$1
          WHERE id=$2
          RETURNING *
          `,
          [
            JSON.stringify(owned),
            user.id
          ]
        );

      broadcast();

      res.json({
        user:
          publicUser(
            updated.rows[0]
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось снять ранг.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   LIST RANKS
===================================================== */

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
          ORDER BY price ASC
          `
        );

      res.json({
        ranks:
          result.rows
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось загрузить ранги.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   CREATE RANK
===================================================== */

app.post(
  '/api/admin/ranks',
  adminAuth,
  async (req, res) => {
    try {
      const id =
        String(
          req.body?.id || ''
        )
          .trim()
          .toLowerCase();

      const name =
        String(
          req.body?.name || ''
        ).trim();

      const title =
        String(
          req.body?.title || ''
        ).trim();

      const price =
        Number(
          req.body?.price
        );

      const color =
        String(
          req.body?.color ||
            '#ffffff'
        );

      const icon =
        String(
          req.body?.icon ||
            '★'
        );

      if (
        !/^[a-z0-9_-]{2,30}$/.test(
          id
        )
      ) {
        return res.status(400).json({
          error:
            'ID ранга должен содержать 2–30 символов: a-z, 0-9, _ или -.'
        });
      }

      if (!name || !title) {
        return res.status(400).json({
          error:
            'Заполни название и заголовок.'
        });
      }

      if (
        !Number.isFinite(price) ||
        price < 0
      ) {
        return res.status(400).json({
          error:
            'Некорректная цена.'
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO ranks
          (id,name,title,price,color,icon)
          VALUES($1,$2,$3,$4,$5,$6)
          RETURNING *
          `,
          [
            id,
            name,
            title,
            Math.trunc(price),
            color,
            icon
          ]
        );

      broadcast();

      res.json({
        rank:
          result.rows[0]
      });
    } catch (error) {
      console.error(error);

      if (
        error.code === '23505'
      ) {
        return res.status(409).json({
          error:
            'Ранг с таким ID уже существует.'
        });
      }

      res.status(500).json({
        error:
          'Не удалось создать ранг.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   DELETE RANK
===================================================== */

app.delete(
  '/api/admin/ranks/:id',
  adminAuth,
  async (req, res) => {
    try {
      const id =
        req.params.id;

      const result =
        await pool.query(
          `
          DELETE FROM ranks
          WHERE id=$1
          RETURNING *
          `,
          [id]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Ранг не найден.'
        });
      }

      /* Убираем этот ранг у игроков */

      const users =
        await pool.query(
          `
          SELECT id, owned_ranks
          FROM users
          `
        );

      for (
        const user of users.rows
      ) {
        const owned =
          Array.isArray(
            user.owned_ranks
          )
            ? user.owned_ranks.filter(
                rankId =>
                  rankId !== id
              )
            : [];

        await pool.query(
          `
          UPDATE users
          SET owned_ranks=$1
          WHERE id=$2
          `,
          [
            JSON.stringify(owned),
            user.id
          ]
        );
      }

      broadcast();

      res.json({
        success: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось удалить ранг.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   LIST QUESTS
===================================================== */

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
          ORDER BY title ASC
          `
        );

      res.json({
        quests:
          result.rows
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось загрузить квесты.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   CREATE QUEST
===================================================== */

app.post(
  '/api/admin/quests',
  adminAuth,
  async (req, res) => {
    try {
      const id =
        String(
          req.body?.id || ''
        )
          .trim()
          .toLowerCase();

      const title =
        String(
          req.body?.title || ''
        ).trim();

      const reward =
        Number(
          req.body?.reward
        );

      const xp =
        Number(
          req.body?.xp
        );

      const description =
        String(
          req.body?.description ||
            ''
        ).trim();

      if (
        !/^[a-z0-9_-]{2,50}$/.test(
          id
        )
      ) {
        return res.status(400).json({
          error:
            'Некорректный ID квеста.'
        });
      }

      if (!title) {
        return res.status(400).json({
          error:
            'Укажи название квеста.'
        });
      }

      if (
        !Number.isFinite(reward) ||
        reward < 0
      ) {
        return res.status(400).json({
          error:
            'Некорректная награда.'
        });
      }

      if (
        !Number.isFinite(xp) ||
        xp < 0
      ) {
        return res.status(400).json({
          error:
            'Некорректный XP.'
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO quests
          (id,title,reward,xp,description)
          VALUES($1,$2,$3,$4,$5)
          RETURNING *
          `,
          [
            id,
            title,
            Math.trunc(reward),
            Math.trunc(xp),
            description
          ]
        );

      broadcast();

      res.json({
        quest:
          result.rows[0]
      });
    } catch (error) {
      console.error(error);

      if (
        error.code === '23505'
      ) {
        return res.status(409).json({
          error:
            'Квест с таким ID уже существует.'
        });
      }

      res.status(500).json({
        error:
          'Не удалось создать квест.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   DELETE QUEST
===================================================== */

app.delete(
  '/api/admin/quests/:id',
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          DELETE FROM quests
          WHERE id=$1
          RETURNING *
          `,
          [req.params.id]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Квест не найден.'
        });
      }

      broadcast();

      res.json({
        success: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось удалить квест.'
      });
    }
  }
);

/* =====================================================
   ADMIN
   RESET USER QUEST
===================================================== */

app.post(
  '/api/admin/users/:id/quests/reset',
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          UPDATE users
          SET claimed_quests='{}'
          WHERE id=$1
          RETURNING *
          `,
          [req.params.id]
        );

      if (!result.rows[0]) {
        return res.status(404).json({
          error:
            'Игрок не найден.'
        });
      }

      res.json({
        user:
          publicUser(
            result.rows[0]
          )
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Не удалось сбросить квесты.'
      });
    }
  }
);

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get(
  '/api/health',
  async (req, res) => {
    try {
      await pool.query(
        'SELECT 1'
      );

      res.json({
        ok: true,
        service:
          'ASTRO ONLINE'
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          'Database unavailable'
      });
    }
  }
);

/* =====================================================
   FRONTEND
===================================================== */

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

/* =====================================================
   START
===================================================== */

init()
  .then(() => {
    server.listen(
      PORT,
      '0.0.0.0',
      () => {
        console.log(
          `ASTRO ONLINE listening on :${PORT}`
        );
      }
    );
  })
  .catch(error => {
    console.error(
      'ASTRO START ERROR:',
      error
    );

    process.exit(1);
  });
