require('dotenv').config();
const path=require('path');
const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const {Pool}=require('pg');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');

const PORT=Number(process.env.PORT||3000);
const DATABASE_URL=process.env.DATABASE_URL;
const JWT_SECRET=process.env.JWT_SECRET||'change-this-secret-before-deploying';

if(!DATABASE_URL){
  console.warn('DATABASE_URL is missing.');
}

const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:DATABASE_URL&&/localhost|127\.0\.0\.1/.test(DATABASE_URL)
    ? false
    : {rejectUnauthorized:false}
});

const app=express();
const server=http.createServer(app);
const io=new Server(server);

app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(__dirname,'public')));

const DEFAULT_RANKS=[
  {
    id:'bronze',
    name:'BRONZE',
    title:'Бронзовый',
    price:5000,
    color:'#cd7f32',
    icon:'◆'
  },
  {
    id:'silver',
    name:'SILVER',
    title:'Серебряный',
    price:15000,
    color:'#b9c3d0',
    icon:'◇'
  },
  {
    id:'gold',
    name:'GOLD',
    title:'Золотой',
    price:35000,
    color:'#ffd45a',
    icon:'✦'
  },
  {
    id:'diamond',
    name:'DIAMOND',
    title:'Алмазный',
    price:75000,
    color:'#6ee7ff',
    icon:'✧'
  },
  {
    id:'master',
    name:'MASTER',
    title:'Мастер',
    price:150000,
    color:'#c084fc',
    icon:'✹'
  },
  {
    id:'astro',
    name:'ASTRO',
    title:'ASTRO ELITE',
    price:300000,
    color:'#ff6bd6',
    icon:'★'
  }
];

const DEFAULT_QUESTS=[
  {
    id:'daily-login',
    title:'Войти в систему',
    reward:50,
    xp:25,
    description:'Открой профиль и забери ежедневную награду.'
  },
  {
    id:'daily-explore',
    title:'Исследователь',
    reward:100,
    xp:50,
    description:'Посети разделы ASTRO и изучи новый сезон.'
  },
  {
    id:'daily-elite',
    title:'Elite Protocol',
    reward:250,
    xp:100,
    description:'Выполни особое задание сезона.'
  }
];

async function init(){

  await pool.query(
    'CREATE EXTENSION IF NOT EXISTS pgcrypto'
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
      title TEXT NOT NULL,
      price BIGINT NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#a855f7',
      icon TEXT NOT NULL DEFAULT '◆',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quests(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      reward BIGINT NOT NULL DEFAULT 0,
      xp BIGINT NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for(const r of DEFAULT_RANKS){

    await pool.query(
      `
      INSERT INTO ranks(
        id,
        name,
        title,
        price,
        color,
        icon
      )
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO NOTHING
      `,
      [
        r.id,
        r.name,
        r.title,
        r.price,
        r.color,
        r.icon
      ]
    );

  }

  for(const q of DEFAULT_QUESTS){

    await pool.query(
      `
      INSERT INTO quests(
        id,
        title,
        reward,
        xp,
        description
      )
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO NOTHING
      `,
      [
        q.id,
        q.title,
        q.reward,
        q.xp,
        q.description
      ]
    );

  }

  console.log('ASTRO database ready');
}

function publicUser(u){

  return {
    id:u.id,
    email:u.email,
    username:u.username,
    balance:Number(u.balance),
    xp:Number(u.xp),
    elo:Number(u.elo),
    wins:Number(u.wins),
    ownedRanks:u.owned_ranks||[],
    claimedQuests:u.claimed_quests||{},
    history:u.history||[],
    createdAt:u.created_at,
    lastLoginAt:u.last_login_at
  };

}

function tokenFor(u){

  return jwt.sign(
    {id:u.id},
    JWT_SECRET,
    {expiresIn:'30d'}
  );

}

async function auth(req,res,next){

  try{

    const h=req.headers.authorization||'';

    const t=h.startsWith('Bearer ')
      ? h.slice(7)
      : '';

    if(!t){
      return res.status(401).json({
        error:'Требуется вход.'
      });
    }

    const p=jwt.verify(
      t,
      JWT_SECRET
    );

    const q=await pool.query(
      'SELECT * FROM users WHERE id=$1',
      [p.id]
    );

    if(!q.rows[0]){
      throw Error();
    }

    req.user=q.rows[0];

    next();

  }catch(e){

    res.status(401).json({
      error:'Сессия недействительна.'
    });

  }

}

function broadcast(){

  io.emit(
    'leaderboard:update'
  );

}

async function getRanks(){

  const q=await pool.query(
    'SELECT * FROM ranks ORDER BY created_at'
  );

  return q.rows.map(r=>({
    id:r.id,
    name:r.name,
    title:r.title,
    price:Number(r.price),
    color:r.color,
    icon:r.icon
  }));

}

async function getQuests(){

  const q=await pool.query(
    'SELECT * FROM quests ORDER BY created_at'
  );

  return q.rows.map(q=>({
    id:q.id,
    title:q.title,
    reward:Number(q.reward),
    xp:Number(q.xp),
    description:q.description
  }));

}


/* =========================
   AUTH
========================= */

app.get(
  '/api/me',
  auth,
  (req,res)=>{
    res.json({
      user:publicUser(req.user)
    });
  }
);

app.post(
  '/api/register',
  async(req,res)=>{

    try{

      const {
        username,
        email,
        password
      }=req.body||{};

      const e=String(email||'')
        .trim()
        .toLowerCase();

      const n=String(username||'')
        .trim();

      if(!/^\S+@\S+\.\S+$/.test(e)){

        return res.status(400).json({
          error:'Введите корректный email.'
        });

      }

      if(!/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(n)){

        return res.status(400).json({
          error:'Никнейм: 3–20 символов.'
        });

      }

      if(String(password||'').length<8){

        return res.status(400).json({
          error:'Пароль должен содержать минимум 8 символов.'
        });

      }

      const exists=await pool.query(
        `
        SELECT 1
        FROM users
        WHERE lower(email)=lower($1)
        OR lower(username)=lower($2)
        `,
        [e,n]
      );

      if(exists.rowCount){

        return res.status(409).json({
          error:'Email или никнейм уже занят.'
        });

      }

      const hash=await bcrypt.hash(
        password,
        12
      );

      const q=await pool.query(
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

      broadcast();

      res.json({
        token:tokenFor(q.rows[0]),
        user:publicUser(q.rows[0])
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Не удалось создать аккаунт.'
      });

    }

  }
);

app.post(
  '/api/login',
  async(req,res)=>{

    try{

      const {
        email,
        password
      }=req.body||{};

      const q=await pool.query(
        `
        SELECT *
        FROM users
        WHERE lower(email)=lower($1)
        `,
        [
          String(email||'').trim()
        ]
      );

      const u=q.rows[0];

      if(
        !u ||
        !(await bcrypt.compare(
          String(password||''),
          u.password_hash
        ))
      ){

        return res.status(401).json({
          error:'Неверный email или пароль.'
        });

      }

      await pool.query(
        `
        UPDATE users
        SET last_login_at=now()
        WHERE id=$1
        `,
        [u.id]
      );

      const fresh=(
        await pool.query(
          'SELECT * FROM users WHERE id=$1',
          [u.id]
        )
      ).rows[0];

      res.json({
        token:tokenFor(fresh),
        user:publicUser(fresh)
      });

    }catch(e){

      res.status(500).json({
        error:'Ошибка входа.'
      });

    }

  }
);


/* =========================
   LEADERBOARD
========================= */

app.get(
  '/api/leaderboard',
  async(req,res)=>{

    try{

      const q=await pool.query(
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
        players:q.rows.map(u=>({

          id:u.id,

          username:u.username,

          elo:Number(u.elo),

          xp:Number(u.xp),

          wins:Number(u.wins),

          ownedRanks:u.owned_ranks||[]

        })),

        quests:await getQuests(),

        ranks:await getRanks()

      });

    }catch(e){

      res.status(500).json({
        error:'Ошибка рейтинга.'
      });

    }

  }
);

app.get(
  '/api/ranks',
  async(req,res)=>{

    try{

      res.json({
        ranks:await getRanks()
      });

    }catch(e){

      res.status(500).json({
        error:'Ошибка рангов.'
      });

    }

  }
);

app.get(
  '/api/quests',
  async(req,res)=>{

    try{

      res.json({
        quests:await getQuests()
      });

    }catch(e){

      res.status(500).json({
        error:'Ошибка квестов.'
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
  async(req,res)=>{

    try{

      const n=String(
        req.body?.username||''
      ).trim();

      if(
        !/^[a-zA-Zа-яА-ЯёЁ0-9_ -]{3,20}$/.test(n)
      ){

        return res.status(400).json({
          error:'Никнейм: 3–20 символов.'
        });

      }

      const dup=await pool.query(
        `
        SELECT 1
        FROM users
        WHERE lower(username)=lower($1)
        AND id<>$2
        `,
        [
          n,
          req.user.id
        ]
      );

      if(dup.rowCount){

        return res.status(409).json({
          error:'Такой никнейм уже занят.'
        });

      }

      const q=await pool.query(
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
        user:publicUser(q.rows[0])
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось сохранить профиль.'
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
  async(req,res)=>{

    const allRanks=await getRanks();

    const rank=allRanks.find(
      r=>r.id===req.params.id
    );

    if(!rank){

      return res.status(404).json({
        error:'Ранг не найден.'
      });

    }

    const c=await pool.connect();

    try{

      await c.query('BEGIN');

      const q=await c.query(
        `
        SELECT *
        FROM users
        WHERE id=$1
        FOR UPDATE
        `,
        [req.user.id]
      );

      const u=q.rows[0];

      const owned=u.owned_ranks||[];

      if(owned.includes(rank.id)){

        throw Error(
          'Этот ранг уже куплен.'
        );

      }

      if(
        Number(u.balance)<rank.price
      ){

        throw Error(
          `Не хватает ${
            (
              rank.price-
              Number(u.balance)
            ).toLocaleString('ru-RU')
          } ₽`
        );

      }

      owned.push(rank.id);

      const history=[
        ...(u.history||[]),
        {
          title:`Покупка ранга · ${rank.name}`,
          amount:-rank.price,
          createdAt:new Date().toISOString()
        }
      ].slice(-30);

      const up=await c.query(
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
          rank.price,
          JSON.stringify(owned),
          JSON.stringify(history),
          u.id
        ]
      );

      await c.query('COMMIT');

      broadcast();

      res.json({
        user:publicUser(up.rows[0]),
        rank
      });

    }catch(e){

      await c.query('ROLLBACK');

      res.status(400).json({
        error:e.message
      });

    }finally{

      c.release();

    }

  }
);


/* =========================
   QUEST CLAIM
========================= */

app.post(
  '/api/quests/:id/claim',
  auth,
  async(req,res)=>{

    const allQuests=await getQuests();

    const quest=allQuests.find(
      q=>q.id===req.params.id
    );

    if(!quest){

      return res.status(404).json({
        error:'Квест не найден.'
      });

    }

    const c=await pool.connect();

    try{

      await c.query('BEGIN');

      const u=(
        await c.query(
          `
          SELECT *
          FROM users
          WHERE id=$1
          FOR UPDATE
          `,
          [req.user.id]
        )
      ).rows[0];

      const claimed=
        u.claimed_quests||{};

      if(claimed[quest.id]){

        throw Error(
          'Этот квест уже получен.'
        );

      }

      claimed[quest.id]=true;

      const history=[
        ...(u.history||[]),
        {
          title:`Квест · ${quest.title}`,
          amount:quest.reward,
          createdAt:new Date().toISOString()
        }
      ].slice(-30);

      const up=await c.query(
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
          quest.reward,
          quest.xp,
          JSON.stringify(claimed),
          JSON.stringify(history),
          u.id
        ]
      );

      await c.query('COMMIT');

      broadcast();

      res.json({
        user:publicUser(up.rows[0]),
        reward:quest.reward,
        xp:quest.xp
      });

    }catch(e){

      await c.query('ROLLBACK');

      res.status(400).json({
        error:e.message
      });

    }finally{

      c.release();

    }

  }
);


/* =====================================================
   ADMIN
   ===================================================== */


/* ----- список пользователей ----- */

app.get(
  '/api/admin/users',
  async(req,res)=>{

    try{

      const q=await pool.query(
        `
        SELECT *
        FROM users
        ORDER BY
          elo DESC,
          xp DESC,
          wins DESC
        `
      );

      res.json({
        users:q.rows.map(
          publicUser
        )
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось загрузить пользователей.'
      });

    }

  }
);


/* ----- изменить баланс / XP / ELO / победы ----- */

app.put(
  '/api/admin/users/:id',
  async(req,res)=>{

    try{

      const fields=[
        'balance',
        'xp',
        'elo',
        'wins'
      ];

      const set=[];
      const values=[];

      for(
        const field of fields
      ){

        if(
          req.body[field]!==undefined
        ){

          const n=Math.floor(
            Number(
              req.body[field]
            )
          );

          if(
            !Number.isFinite(n) ||
            n<0
          ){

            return res.status(400).json({
              error:`Неверное значение ${field}`
            });

          }

          set.push(
            `${field}=$${values.length+1}`
          );

          values.push(n);

        }

      }

      if(!set.length){

        return res.status(400).json({
          error:'Нет данных для изменения.'
        });

      }

      values.push(
        req.params.id
      );

      const q=await pool.query(
        `
        UPDATE users
        SET ${set.join(',')}
        WHERE id=$${values.length}
        RETURNING *
        `,
        values
      );

      if(!q.rows[0]){

        return res.status(404).json({
          error:'Игрок не найден.'
        });

      }

      broadcast();

      res.json({
        user:publicUser(
          q.rows[0]
        )
      });

    }catch(e){

      console.error(e);

      res.status(500).json({
        error:'Не удалось изменить игрока.'
      });

    }

  }
);


/* ----- выдать ранг ----- */

app.post(
  '/api/admin/users/:id/ranks/:rankId',
  async(req,res)=>{

    try{

      const u=(
        await pool.query(
          'SELECT * FROM users WHERE id=$1',
          [req.params.id]
        )
      ).rows[0];

      const r=(
        await pool.query(
          'SELECT * FROM ranks WHERE id=$1',
          [req.params.rankId]
        )
      ).rows[0];

      if(!u||!r){

        return res.status(404).json({
          error:'Игрок или ранг не найден.'
        });

      }

      const owned=[
        ...(u.owned_ranks||[])
      ];

      if(!owned.includes(r.id)){

        owned.push(r.id);

      }

      const q=await pool.query(
        `
        UPDATE users
        SET owned_ranks=$1
        WHERE id=$2
        RETURNING *
        `,
        [
          JSON.stringify(owned),
          u.id
        ]
      );

      broadcast();

      res.json({
        user:publicUser(
          q.rows[0]
        )
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось выдать ранг.'
      });

    }

  }
);


/* ----- снять ранг ----- */

app.delete(
  '/api/admin/users/:id/ranks/:rankId',
  async(req,res)=>{

    try{

      const u=(
        await pool.query(
          'SELECT * FROM users WHERE id=$1',
          [req.params.id]
        )
      ).rows[0];

      if(!u){

        return res.status(404).json({
          error:'Игрок не найден.'
        });

      }

      const owned=(
        u.owned_ranks||[]
      ).filter(
        x=>x!==req.params.rankId
      );

      const q=await pool.query(
        `
        UPDATE users
        SET owned_ranks=$1
        WHERE id=$2
        RETURNING *
        `,
        [
          JSON.stringify(owned),
          u.id
        ]
      );

      broadcast();

      res.json({
        user:publicUser(
          q.rows[0]
        )
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось снять ранг.'
      });

    }

  }
);


/* ----- создать ранг ----- */

app.post(
  '/api/admin/ranks',
  async(req,res)=>{

    try{

      const {
        id,
        name,
        title,
        price,
        color,
        icon
      }=req.body||{};

      const rid=String(id||'')
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9_-]/g,
          '-'
        );

      if(
        !rid ||
        !name ||
        !title
      ){

        return res.status(400).json({
          error:'Нужны ID, название и титул.'
        });

      }

      const q=await pool.query(
        `
        INSERT INTO ranks(
          id,
          name,
          title,
          price,
          color,
          icon
        )
        VALUES(
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        RETURNING *
        `,
        [
          rid,
          String(name),
          String(title),
          Math.max(
            0,
            Number(price)||0
          ),
          String(
            color||'#a855f7'
          ),
          String(
            icon||'◆'
          )
        ]
      );

      broadcast();

      res.json({
        rank:q.rows[0]
      });

    }catch(e){

      res.status(400).json({
        error:
          'Не удалось создать ранг. Возможно, такой ID уже существует.'
      });

    }

  }
);


/* ----- удалить ранг ----- */

app.delete(
  '/api/admin/ranks/:id',
  async(req,res)=>{

    try{

      await pool.query(
        'DELETE FROM ranks WHERE id=$1',
        [req.params.id]
      );

      const q=await pool.query(
        'SELECT id,owned_ranks FROM users'
      );

      for(
        const u of q.rows
      ){

        const owned=(
          u.owned_ranks||[]
        ).filter(
          x=>x!==req.params.id
        );

        await pool.query(
          `
          UPDATE users
          SET owned_ranks=$1
          WHERE id=$2
          `,
          [
            JSON.stringify(owned),
            u.id
          ]
        );

      }

      broadcast();

      res.json({
        success:true
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось удалить ранг.'
      });

    }

  }
);


/* ----- создать квест ----- */

app.post(
  '/api/admin/quests',
  async(req,res)=>{

    try{

      const {
        id,
        title,
        reward,
        xp,
        description
      }=req.body||{};

      const qid=String(id||'')
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9_-]/g,
          '-'
        );

      if(
        !qid ||
        !title
      ){

        return res.status(400).json({
          error:'Нужны ID и название.'
        });

      }

      const q=await pool.query(
        `
        INSERT INTO quests(
          id,
          title,
          reward,
          xp,
          description
        )
        VALUES(
          $1,
          $2,
          $3,
          $4,
          $5
        )
        RETURNING *
        `,
        [
          qid,
          String(title),
          Math.max(
            0,
            Number(reward)||0
          ),
          Math.max(
            0,
            Number(xp)||0
          ),
          String(
            description||''
          )
        ]
      );

      broadcast();

      res.json({
        quest:q.rows[0]
      });

    }catch(e){

      res.status(400).json({
        error:
          'Не удалось создать квест. Возможно, такой ID уже существует.'
      });

    }

  }
);


/* ----- изменить квест ----- */

app.put(
  '/api/admin/quests/:id',
  async(req,res)=>{

    try{

      const {
        title,
        reward,
        xp,
        description
      }=req.body||{};

      const q=await pool.query(
        `
        UPDATE quests
        SET
          title=$1,
          reward=$2,
          xp=$3,
          description=$4
        WHERE id=$5
        RETURNING *
        `,
        [
          String(title||''),
          Math.max(
            0,
            Number(reward)||0
          ),
          Math.max(
            0,
            Number(xp)||0
          ),
          String(
            description||''
          ),
          req.params.id
        ]
      );

      if(!q.rows[0]){

        return res.status(404).json({
          error:'Квест не найден.'
        });

      }

      broadcast();

      res.json({
        quest:q.rows[0]
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось изменить квест.'
      });

    }

  }
);


/* ----- удалить квест ----- */

app.delete(
  '/api/admin/quests/:id',
  async(req,res)=>{

    try{

      await pool.query(
        'DELETE FROM quests WHERE id=$1',
        [req.params.id]
      );

      await pool.query(
        `
        UPDATE users
        SET claimed_quests=
          COALESCE(
            claimed_quests-$1,
            '{}'::jsonb
          )
        `,
        [
          req.params.id
        ]
      );

      broadcast();

      res.json({
        success:true
      });

    }catch(e){

      res.status(500).json({
        error:'Не удалось удалить квест.'
      });

    }

  }
);


/* =========================
   START
========================= */

app.get(
  '*',
  (req,res)=>{
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);

init()
  .then(
    ()=>{
      server.listen(
        PORT,
        ()=>{
          console.log(
            `ASTRO ONLINE listening on :${PORT}`
          );
        }
      );
    }
  )
  .catch(
    e=>{
      console.error(e);
      process.exit(1);
    }
  );
