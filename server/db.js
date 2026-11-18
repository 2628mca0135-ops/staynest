// MongoDB (Mongoose) connection + models.
// Every document keeps a small integer `id` (allocated from the `counters` collection) so the public
// API / frontend URLs (/api/pgs/12, ...) stay the same as before. Mongo's own _id is never exposed.
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch (_) {} // load .env if present (Node 20.12+)
const mongoose = require('mongoose');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/staynest';
mongoose.set('strictQuery', true);
// If the URI has no /database part, MongoDB silently uses "test" — which may hold other projects' data. Force our own database.
const hasDb = /^mongodb(\+srv)?:\/\/[^/?]+\/[^?\s]+/.test(URI);
const DB_OPTS = hasDb ? {} : { dbName: process.env.MONGODB_DB || 'staynest' };

const { Schema } = mongoose;
const now = () => new Date();
const mk = (name, def, indexes = []) => {
  const s = new Schema(def, { versionKey: false });
  indexes.forEach(([f, o]) => s.index(f, o));
  return mongoose.model(name, s);
};
const ID = { type: Number, required: true, unique: true };
const REF = { type: Number, required: true };
const TS = { type: Date, default: now };

const Counter = mk('Counter', { _id: String, seq: { type: Number, default: 0 } });
async function nextId(name) {
  const c = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return c.seq;
}

const User = mk('User', {
  id: ID, name: { type: String, required: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: String, password_hash: { type: String, required: true },
  role: { type: String, enum: ['student', 'owner'], default: 'student' }, city: String, created_at: TS,
});

const Pg = mk('Pg', {
  id: ID, owner_id: REF, name: { type: String, required: true }, city: { type: String, required: true }, area: { type: String, required: true },
  address: { type: String, required: true }, gender: { type: String, enum: ['Boys', 'Girls', 'Co-ed'], required: true },
  description: { type: String, default: '' }, facilities: { type: [String], default: [] }, image: String, gallery: { type: [String], default: [] },
  deposit: { type: Number, default: 0 }, rules: { type: [String], default: [] }, active: { type: Boolean, default: true }, created_at: TS,
}, [[{ city: 1 }], [{ owner_id: 1 }]]);

const Room = mk('Room', {
  pg_id: REF, type: { type: String, enum: ['Single', 'Double', 'Triple'], required: true },
  price: { type: Number, required: true, min: 1 }, available: { type: Number, default: 0, min: 0 },
}, [[{ pg_id: 1, type: 1 }, { unique: true }]]);

const Saved = mk('Saved', { user_id: REF, pg_id: REF, created_at: TS }, [[{ user_id: 1, pg_id: 1 }, { unique: true }]]);

const Booking = mk('Booking', {
  id: ID, user_id: REF, pg_id: REF, kind: { type: String, enum: ['booking', 'inquiry'], default: 'booking' },
  room_type: String, move_in: String, name: { type: String, required: true }, phone: { type: String, required: true },
  message: { type: String, default: '' }, status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  owner_note: { type: String, default: '' }, created_at: TS, updated_at: TS,
}, [[{ user_id: 1 }], [{ pg_id: 1 }]]);

const Review = mk('Review', {
  id: ID, pg_id: REF, user_id: REF, rating: { type: Number, min: 1, max: 5, required: true }, text: { type: String, required: true }, created_at: TS,
}, [[{ pg_id: 1, user_id: 1 }, { unique: true }]]);

const Complaint = mk('Complaint', {
  id: ID, user_id: REF, pg_id: REF, subject: { type: String, required: true }, category: { type: String, required: true },
  details: { type: String, required: true }, status: { type: String, enum: ['open', 'progress', 'resolved'], default: 'open' },
  response: { type: String, default: '' }, created_at: TS, updated_at: TS,
}, [[{ user_id: 1 }], [{ pg_id: 1 }]]);

const Contact = mk('Contact', { name: String, email: String, message: String, created_at: TS });

// Remove Mongo internals and format dates as "YYYY-MM-DD HH:MM:SS" (UTC) — what the frontend expects.
const fmtDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
function clean(o) {
  if (!o) return o;
  const { _id, ...rest } = o;
  for (const k of Object.keys(rest)) if (rest[k] instanceof Date) rest[k] = fmtDate(rest[k]);
  return rest;
}

let connecting, devServer;
// Connects to MONGODB_URI. In development, if no MongoDB is running on localhost and no URI was given,
// a local dev MongoDB is started automatically (data kept in ./data/mongo) so `npm start` just works.
function connect() {
  if (!connecting) {
    connecting = (async () => {
      const explicit = !!process.env.MONGODB_URI;
      try {
        try {
          await mongoose.connect(URI, { ...DB_OPTS, serverSelectionTimeoutMS: explicit ? 8000 : 2500 });
        } catch (e) {
          // Some networks/routers/VPNs refuse the DNS SRV lookup Atlas (mongodb+srv://) needs -> retry via public DNS
          if (!/querySrv|querytxt/i.test(String(e.message))) throw e;
          console.log('⚠️  DNS SRV lookup failed on your network — retrying with Google/Cloudflare DNS...');
          require('dns').setServers(['8.8.8.8', '1.1.1.1']);
          await mongoose.disconnect();
          await mongoose.connect(URI, { ...DB_OPTS, serverSelectionTimeoutMS: 10000 });
        }
      } catch (e) {
        if (explicit || ['production', 'test'].includes(process.env.NODE_ENV)) throw e;
        let MongoMemoryServer;
        try { ({ MongoMemoryServer } = require('mongodb-memory-server')); } catch (_) {
          throw new Error(`No MongoDB at ${URI}. Install/start MongoDB (or run "docker compose up -d") or set MONGODB_URI.`);
        }
        const dbPath = require('path').join(process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'), 'mongo');
        require('fs').mkdirSync(dbPath, { recursive: true });
        console.log('No MongoDB found on localhost — starting a local dev MongoDB (first run downloads it, please wait)...');
        devServer = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } });
        await mongoose.disconnect();
        await mongoose.connect(devServer.getUri('staynest'));
        console.log('Dev MongoDB running → data stored in', dbPath);
      }
      await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // build indexes
      const c = mongoose.connection;
      console.log(`✅ MongoDB connected → host: ${c.host}, database: ${c.name}${/mongodb\+srv/.test(URI) ? ' (Atlas)' : ''}`);
      if (!process.env.MONGODB_URI) console.log('⚠️  MONGODB_URI not set (.env not found/loaded) — using local MongoDB, NOT Atlas.');
      return mongoose;
    })();
    connecting.catch(() => { connecting = null; });
  }
  return connecting;
}
const disconnect = async () => { connecting = null; await mongoose.disconnect(); if (devServer) await devServer.stop(); };

module.exports = { mongoose, connect, disconnect, nextId, clean, now, Counter, User, Pg, Room, Saved, Booking, Review, Complaint, Contact };
