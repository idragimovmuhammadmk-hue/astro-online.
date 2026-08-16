```javascript
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
const JWT_SECRET = process.env.JWT_SECRET || 'astro-secret-change-me';

const ADMIN_EMAIL = 'admin@astro.online';
const ADMIN_PASSWORD = 'AstroAdmin123!';

if (!DATABASE_URL) {
  console.warn('DATABASE_URL is missing');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    DATABASE_URL && /localhost|127\.0\.0\.1/.test(DATABASE_URL)
      ? false
      : { rejectUnauthorized: false }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let RANKS = [
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

let QUESTS = [
  {
    id: 'daily-login',
    title: 'Войти в систему',
    reward: 50,
    xp: 25,
    description: 'Открой профиль и забери ежедневную награду.'
  },
  {
    id: 'daily-explore',
    title: 'Исследователь',
    reward: 100,
    xp: 50,
    description: 'Посети разделы ASTRO.'
  },
  {
    id: 'daily-elite',
    title: 'Elite Protocol',
    reward: 250,
    xp: 100,
    description: 'Выполни особое задание сезона.'
  }
];

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    balance: Number(u.balance || 0),
    xp: Number(u.xp || 0),
    elo: Number(u.elo || 1000),
    wins: Number(u.wins || 0),
    ownedRanks: u.owned_ranks || [],
    claimedQuests: u.claimed_quests || {},
    history: u.history || [],
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at
  };
}

function tokenFor(u) {
  return jwt.sign(
    { id: u.id },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function getUserById(id) {
  const q = await pool.query(
    'SELECT * FROM users WHERE id=$1',
    [id]
  );

  return q.rows[0];
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Требуется вход.'
      });
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.id);

    if (!user) {
      return res.status(401).json({
        error: 'Пользователь не найден.'
      });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({
      error: 'Сессия недействительна.'
    });
  }
}

function adminAuth(req, res, next) {
  const email = String(req.headers['x-admin-email'] || '');
  const password = String(req.headers['x-admin-password'] || '');

  if (
    email !== ADMIN_EMAIL ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(403).json({
      error: 'Доступ запрещён.'
    });
  }

  next();
}

function broadcast() {
  io.emit('leaderboard:update');
}

async function init() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

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

  console.log('ASTRO database ready');
}

/* =========================
   AUTH
========================= */

app.post('/api/register', async (req, res) => {
  try {
    const {
      username,
      email,
      password
    } = req.body || {};

    const e = String(email || '')
      .trim()
      .toLowerCase();

    const n = String(username || '').trim();
    const p = String(password || '');

    if (!/^\S+@\S+\.\S+$/.test(e)) {
      return res.status(400).json({
        error: 'Введите корректный email.'
      });
    }

    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(n)) {
      return res.status(400).json({
        error: 'Никнейм: 3–20 символов.'
      });
    }

    if (p.length < 8) {
      return res.status(400).json({
        error: 'Пароль должен содержать минимум 8 символов.'
      });
    }

    const exists = await pool.query(
      `SELECT 1 FROM users
       WHERE lower(email)=lower($1)
       OR lower(username)=lower($2)`,
      [e, n]
    );

    if (exists.rowCount) {
      return res.status(409).json({
        error: 'Email или никнейм уже занят.'
      });
    }

    const hash = await bcrypt.hash(p, 12);

    const q = await pool.query(
      `INSERT INTO users(
        id,email,username,password_hash
      )
      VALUES(
        gen_random_uuid(),$1,$2,$3
      )
      RETURNING *`,
      [e, n, hash]
    );

    const user = q.rows[0];

    broadcast();

    res.json({
      token: tokenFor(user),
      user: publicUser(user)
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: 'Не удалось создать аккаунт.'
    });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body || {};

    const q = await pool.query(
      `SELECT * FROM users
       WHERE lower(email)=lower($1)`,
      [String(email || '').trim()]
    );

    const user = q.rows[0];

    if (
      !user ||
      !(await bcrypt.compare(
        String(password || ''),
        user.password_hash
      ))
    ) {
      return res.status(401).json({
        error: 'Неверный email или пароль.'
      });
    }

    await pool.query(
      `UPDATE users
       SET last_login_at=now()
       WHERE id=$1`,
      [user.id]
    );

    const fresh = await getUserById(user.id);

    res.json({
      token: tokenFor(fresh),
      user: publicUser(fresh)
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: 'Ошибка входа.'
    });
  }
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    user: publicUser(req.user)
  });
});

/* =========================
   PUBLIC DATA
========================= */

app.get('/api/config', (req, res) => {
  res.json({
    ranks: RANKS,
    quests: QUESTS
  });
});

app.get('/api/leaderboard', async (req, res) => {
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
      ORDER BY elo DESC, xp DESC, wins DESC
    `);

    res.json({
      players: q.rows.map(u => ({
        id: u.id,
        username: u.username,
        elo: Number(u.elo || 0),
        xp: Number(u.xp || 0),
        wins: Number(u.wins || 0),
        ownedRanks: u.owned_ranks || []
      })),
      ranks: RANKS,
      quests: QUESTS
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: 'Ошибка рейтинга.'
    });
  }
});

/* =========================
   PROFILE
========================= */

app.put('/api/profile', auth, async (req, res) => {
  try {
    const username = String(
      req.body?.username || ''
    ).trim();

    if (
      !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(username)
    ) {
      return res.status(400).json({
        error: 'Никнейм: 3–20 символов.'
      });
    }

    const dup = await pool.query(
      `SELECT 1 FROM users
       WHERE lower(username)=lower($1)
       AND id<>$2`,
      [username, req.user.id]
    );

    if (dup.rowCount) {
      return res.status(409).json({
        error: 'Такой никнейм уже занят.'
      });
    }

    const q = await pool.query(
      `UPDATE users
       SET username=$1
       WHERE id=$2
       RETURNING *`,
      [username, req.user.id]
    );

    broadcast();

    res.json({
      user: publicUser(q.rows[0])
    });
  } catch (e) {
    res.status(500).json({
      error: 'Не удалось сохранить профиль.'
    });
  }
});

/* =========================
   BUY RANK
========================= */

app.post('/api/ranks/:id/buy', auth, async (req, res) => {
  const rank = RANKS.find(
    r => r.id === req.params.id
  );

  if (!rank) {
    return res.status(404).json({
      error: 'Ранг не найден.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const q = await client.query(
      `SELECT * FROM users
       WHERE id=$1
       FOR UPDATE`,
      [req.user.id]
    );

    const user = q.rows[0];
    const owned = [...(user.owned_ranks || [])];

    if (owned.includes(rank.id)) {
      throw new Error(
        'Этот ранг уже куплен.'
      );
    }

    if (Number(user.balance) < rank.price) {
      throw new Error(
        `Не хватает ${
          (rank.price - Number(user.balance))
            .toLocaleString('ru-RU')
        } ₽`
      );
    }

    owned.push(rank.id);

    const history = [
      ...(user.history || []),
      {
        title: `Покупка ранга · ${rank.name}`,
        amount: -rank.price,
        createdAt: new Date().toISOString()
      }
    ].slice(-30);

    const up = await client.query(
      `UPDATE users
       SET
        balance=balance-$1,
        owned_ranks=$2,
        history=$3
       WHERE id=$4
       RETURNING *`,
      [
        rank.price,
        JSON.stringify(owned),
        JSON.stringify(history),
        user.id
      ]
    );

    await client.query('COMMIT');

    broadcast();

    res.json({
      user: publicUser(up.rows[0]),
      rank
    });
  } catch (e) {
    await client.query('ROLLBACK');

    res.status(400).json({
      error: e.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   QUEST
========================= */

app.post('/api/quests/:id/claim', auth, async (req, res) => {
  const quest = QUESTS.find(
    q => q.id === req.params.id
  );

  if (!quest) {
    return res.status(404).json({
      error: 'Квест не найден.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const user = (
      await client.query(
        `SELECT * FROM users
         WHERE id=$1
         FOR UPDATE`,
        [req.user.id]
      )
    ).rows[0];

    const claimed = {
      ...(user.claimed_quests || {})
    };

    if (claimed[quest.id]) {
      throw new Error(
        'Этот квест уже получен.'
      );
    }

    claimed[quest.id] = true;

    const history = [
      ...(user.history || []),
      {
        title: `Квест · ${quest.title}`,
        amount: quest.reward,
        createdAt: new Date().toISOString()
      }
    ].slice(-30);

    const up = await client.query(
      `UPDATE users
       SET
        balance=balance+$1,
        xp=xp+$2,
        claimed_quests=$3,
        history=$4
       WHERE id=$5
       RETURNING *`,
      [
        quest.reward,
        quest.xp,
        JSON.stringify(claimed),
        JSON.stringify(history),
        user.id
      ]
    );

    await client.query('COMMIT');

    broadcast();

    res.json({
      user: publicUser(up.rows[0]),
      reward: quest.reward,
      xp: quest.xp
    });
  } catch (e) {
    await client.query('ROLLBACK');

    res.status(400).json({
      error: e.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   ADMIN LOGIN
========================= */

app.post('/api/admin/login', (req, res) => {
  const email = String(
    req.body?.email || ''
  ).trim();

  const password = String(
    req.body?.password || ''
  );

  if (
    email !== ADMIN_EMAIL ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: 'Неверный email или пароль администратора.'
    });
  }

  res.json({
    success: true,
    admin: {
      email: ADMIN_EMAIL
    }
  });
});

/* =========================
   ADMIN USERS
========================= */

app.get(
  '/api/admin/users',
  adminAuth,
  async (req, res) => {
    try {
      const q = await pool.query(`
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
        ORDER BY elo DESC, xp DESC
      `);

      res.json({
        users: q.rows.map(publicUser)
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        error: 'Не удалось получить пользователей.'
      });
    }
  }
);

/* =========================
   ADMIN GIVE MONEY / XP / ELO / WINS
========================= */

app.post(
  '/api/admin/users/:id/stats',
  adminAuth,
  async (req, res) => {
    try {
      const userId = req.params.id;

      const money = Number(req.body?.money || 0);
      const xp = Number(req.body?.xp || 0);
      const elo = Number(req.body?.elo || 0);
      const wins = Number(req.body?.wins || 0);

      if (
        !Number.isFinite(money) ||
        !Number.isFinite(xp) ||
        !Number.isFinite(elo) ||
        !Number.isFinite(wins)
      ) {
        return res.status(400).json({
          error: 'Некорректные значения.'
        });
      }

      const q = await pool.query(
        `UPDATE users
         SET
          balance=GREATEST(0,balance+$1),
          xp=GREATEST(0,xp+$2),
          elo=GREATEST(0,elo+$3),
          wins=GREATEST(0,wins+$4)
         WHERE id=$5
         RETURNING *`,
        [
          Math.trunc(money),
          Math.trunc(xp),
          Math.trunc(elo),
          Math.trunc(wins),
          userId
        ]
      );

      if (!q.rows[0]) {
        return res.status(404).json({
          error: 'Игрок не найден.'
        });
      }

      broadcast();

      res.json({
        user: publicUser(q.rows[0])
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        error: 'Не удалось изменить статистику.'
      });
    }
  }
);

/* =========================
   ADMIN GIVE / REMOVE RANK
========================= */

app.post(
  '/api/admin/users/:id/rank',
  adminAuth,
  async (req, res) => {
    try {
      const userId = req.params.id;
      const rankId = String(req.body?.rankId || '');
      const action = String(req.body?.action || 'add');

      if (!RANKS.some(r => r.id === rankId)) {
        return res.status(404).json({
          error: 'Ранг не найден.'
        });
      }

      const q = await pool.query(
        `SELECT * FROM users WHERE id=$1`,
        [userId]
      );

      if (!q.rows[0]) {
        return res.status(404).json({
          error: 'Игрок не найден.'
        });
      }

      const user = q.rows[0];
      let owned = [...(user.owned_ranks || [])];

      if (action === 'add') {
        if (!owned.includes(rankId)) {
          owned.push(rankId);
        }
      } else {
        owned = owned.filter(
          id => id !== rankId
        );
      }

      const updated = await pool.query(
        `UPDATE users
         SET owned_ranks=$1
         WHERE id=$2
         RETURNING *`,
        [
          JSON.stringify(owned),
          userId
        ]
      );

      broadcast();

      res.json({
        user: publicUser(updated.rows[0])
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        error: 'Ошибка изменения ранга.'
      });
    }
  }
);

/* =========================
   ADMIN CREATE RANK
========================= */

app.post(
  '/api/admin/ranks',
  adminAuth,
  async (req, res) => {
    try {
      const {
        id,
        name,
        title,
        price,
        color,
        icon
      } = req.body || {};

      const rankId = String(id || '')
        .trim()
        .toLowerCase();

      if (!/^[a-z0-9_-]{2,30}$/.test(rankId)) {
        return res.status(400).json({
          error: 'ID ранга должен содержать 2–30 символов: a-z, 0-9, _ или -.'
        });
      }

      if (RANKS.some(r => r.id === rankId)) {
        return res.status(409).json({
          error: 'Такой ранг уже существует.'
        });
      }

      const rank = {
        id: rankId,
        name: String(name || rankId).slice(0, 30),
        title: String(title || '').slice(0, 50),
        price: Math.max(0, Number(price || 0)),
        color: String(color || '#ffffff'),
        icon: String(icon || '★')
      };

      RANKS.push(rank);

      res.json({
        rank,
        ranks: RANKS
      });
    } catch (e) {
      res.status(500).json({
        error: 'Не удалось создать ранг.'
      });
    }
  }
);

/* =========================
   ADMIN DELETE RANK
========================= */

app.delete(
  '/api/admin/ranks/:id',
  adminAuth,
  async (req, res) => {
    const id = req.params.id;

    if (!RANKS.some(r => r.id === id)) {
      return res.status(404).json({
        error: 'Ранг не найден.'
      });
    }

    RANKS = RANKS.filter(
      r => r.id !== id
    );

    await pool.query(
      `UPDATE users
       SET owned_ranks =
       COALESCE(
         (
           SELECT jsonb_agg(x)
           FROM jsonb_array_elements(owned_ranks) x
           WHERE x <> to_jsonb($1::text)
         ),
         '[]'::jsonb
       )`,
      [id]
    );

    broadcast();

    res.json({
      success: true,
      ranks: RANKS
    });
  }
);

/* =========================
   ADMIN CREATE QUEST
========================= */

app.post(
  '/api/admin/quests',
  adminAuth,
  async (req, res) => {
    try {
      const {
        id,
        title,
        reward,
        xp,
        description
      } = req.body || {};

      const questId = String(id || '')
        .trim()
        .toLowerCase();

      if (!/^[a-z0-9_-]{2,40}$/.test(questId)) {
        return res.status(400).json({
          error: 'Некорректный ID квеста.'
        });
      }

      if (QUESTS.some(q => q.id === questId)) {
        return res.status(409).json({
          error: 'Такой квест уже существует.'
        });
      }

      const quest = {
        id: questId,
        title: String(title || 'Новый квест').slice(0, 100),
        reward: Math.max(0, Number(reward || 0)),
        xp: Math.max(0, Number(xp || 0)),
        description: String(description || '').slice(0, 300)
      };

      QUESTS.push(quest);

      res.json({
        quest,
        quests: QUESTS
      });
    } catch (e) {
      res.status(500).json({
        error: 'Не удалось создать квест.'
      });
    }
  }
);

/* =========================
   ADMIN DELETE QUEST
========================= */

app.delete(
  '/api/admin/quests/:id',
  adminAuth,
  async (req, res) => {
    const id = req.params.id;

    QUESTS = QUESTS.filter(
      q => q.id !== id
    );

    await pool.query(
      `UPDATE users
       SET claimed_quests =
       claimed_quests - $1`,
      [id]
    );

    broadcast();

    res.json({
      success: true,
      quests: QUESTS
    });
  }
);

/* =========================
   SOCKET.IO
========================= */

io.on('connection', socket => {
  socket.emit('leaderboard:update');
});

/* =========================
   FRONTEND
========================= */

app.get('*', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );
});

/* =========================
   START
========================= */

init()
  .then(() => {
    server.listen(
      PORT,
      () => {
        console.log(
          `ASTRO ONLINE listening on :${PORT}`
        );
      }
    );
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
```
