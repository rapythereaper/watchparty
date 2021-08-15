"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = __importDefault(require("./config"));
const fs_1 = __importDefault(require("fs"));
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const compression_1 = __importDefault(require("compression"));
const moniker_1 = __importDefault(require("moniker"));
const os_1 = __importDefault(require("os"));
const cors_1 = __importDefault(require("cors"));
const ioredis_1 = __importDefault(require("ioredis"));
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = __importDefault(require("socket.io"));
const youtube_1 = require("./utils/youtube");
const room_1 = require("./room");
const redis_1 = require("./utils/redis");
const stripe_1 = require("./utils/stripe");
const firebase_1 = require("./utils/firebase");
const path_1 = __importDefault(require("path"));
const pg_1 = require("pg");
const time_1 = require("./utils/time");
const utils_1 = require("./vm/utils");
const string_1 = require("./utils/string");
const postgres_1 = require("./utils/postgres");
const releaseInterval = 5 * 60 * 1000;
const releaseBatches = 5;
const app = express_1.default();
let server = null;
if (config_1.default.HTTPS) {
    const key = fs_1.default.readFileSync(config_1.default.SSL_KEY_FILE);
    const cert = fs_1.default.readFileSync(config_1.default.SSL_CRT_FILE);
    server = https_1.default.createServer({ key: key, cert: cert }, app);
}
else {
    server = new http_1.default.Server(app);
}
const io = socket_io_1.default(server, { origins: '*:*', transports: ['websocket'] });
let redis = undefined;
if (config_1.default.REDIS_URL) {
    redis = new ioredis_1.default(config_1.default.REDIS_URL);
}
let postgres = undefined;
if (config_1.default.DATABASE_URL) {
    postgres = new pg_1.Client({
        connectionString: config_1.default.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });
    postgres.connect();
}
const names = moniker_1.default.generator([
    moniker_1.default.adjective,
    moniker_1.default.noun,
    moniker_1.default.verb,
]);
const launchTime = Number(new Date());
const rooms = new Map();
const vmManagers = utils_1.getBgVMManagers();
init();
function init() {
    return __awaiter(this, void 0, void 0, function* () {
        if (config_1.default.ENABLE_POSTGRES_READING && postgres) {
            console.time('[LOADROOMSPOSTGRES]');
            const permanentRooms = yield getPermanentRooms();
            console.log('found %s rooms in postgres', permanentRooms.length);
            console.timeEnd('[LOADROOMSPOSTGRES]');
            for (let i = 0; i < permanentRooms.length; i++) {
                const key = permanentRooms[i].roomId;
                const data = permanentRooms[i].data
                    ? JSON.stringify(permanentRooms[i].data)
                    : undefined;
                const room = new room_1.Room(io, key, data);
                rooms.set(key, room);
            }
        }
        else if (redis) {
            // Load rooms from Redis
            console.time('[LOADROOMSREDIS]');
            const keys = yield redis.keys(config_1.default.SHARD ? `/${config_1.default.SHARD}-[a-z]*` : '/[a-z]*');
            const data = keys.length ? yield (redis === null || redis === void 0 ? void 0 : redis.mget(keys)) : [];
            console.log('found %s rooms in redis', keys.length);
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const roomData = data[i];
                // console.log(key, roomData);
                try {
                    rooms.set(key, new room_1.Room(io, key, roomData));
                }
                catch (e) {
                    console.warn(e);
                }
            }
            console.timeEnd('[LOADROOMSREDIS]');
            if (postgres) {
                console.time('[LOADMISSINGROOMSPOSTGRES]');
                const permanentRooms = yield getPermanentRooms();
                console.log('found %s rooms in postgres', permanentRooms.length);
                const keySet = new Set(keys);
                for (let i = 0; i < permanentRooms.length; i++) {
                    const key = permanentRooms[i].roomId;
                    const data = JSON.stringify(permanentRooms[i]);
                    if (!keySet.has(key)) {
                        console.log('detected room %s in postgres but not redis', key);
                        const missingRoom = new room_1.Room(io, key, data);
                        missingRoom.saveToRedis(true);
                        rooms.set(key, missingRoom);
                    }
                }
                console.timeEnd('[LOADMISSINGROOMSPOSTGRES]');
                // temporarily give all non-permanent rooms without ttl a 1 day timeout (repair)
                console.time('[TTLREPAIR]');
                const permanentSet = new Set(permanentRooms.map((room) => room.roomId));
                for (let i = 0; i < keys.length; i++) {
                    const ttl = yield redis.ttl(keys[i]);
                    if (ttl === -1 && !permanentSet.has(keys[i])) {
                        console.log('[TTLREPAIR] setting ttl on non-permanent room %s', keys[i]);
                        yield redis.expire(keys[i], 24 * 60 * 60);
                    }
                }
                console.timeEnd('[TTLREPAIR]');
            }
        }
        if (!rooms.has('/default')) {
            rooms.set('/default', new room_1.Room(io, '/default'));
        }
        server.listen(config_1.default.PORT, config_1.default.HOST);
        // Following functions iterate over in-memory rooms
        setInterval(minuteMetrics, 60 * 1000);
        setInterval(release, releaseInterval / releaseBatches);
        setInterval(cleanupRooms, 5 * 60 * 1000);
        saveRooms();
        if (process.env.NODE_ENV === 'development') {
            require('./vmWorker');
            require('./syncSubs');
            require('./timeSeries');
        }
    });
}
app.use(cors_1.default());
app.use(body_parser_1.default.json());
app.get('/ping', (_req, res) => {
    res.json('pong');
});
// Data's already compressed so go before the compression middleware
app.get('/subtitle/:hash', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const gzipped = yield (redis === null || redis === void 0 ? void 0 : redis.getBuffer('subtitle:' + req.params.hash));
    if (!gzipped) {
        return res.status(404).end('not found');
    }
    res.setHeader('Content-Encoding', 'gzip');
    res.end(gzipped);
}));
app.use(compression_1.default());
app.get('/stats', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.query.key && req.query.key === config_1.default.STATS_KEY) {
        const stats = yield getStats();
        res.json(stats);
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.get('/health/:metric', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const stats = yield getStats();
    const metrics = {
        vBrowser: Boolean((_a = stats.availableVBrowsers) === null || _a === void 0 ? void 0 : _a.length),
        vBrowserLarge: Boolean((_b = stats.availableVBrowsersLarge) === null || _b === void 0 ? void 0 : _b.length),
    };
    const result = metrics[req.params.metric];
    res.status(result ? 200 : 500).json(result);
}));
app.get('/timeSeries', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.query.key && req.query.key === config_1.default.STATS_KEY && redis) {
        const timeSeriesData = yield redis.lrange('timeSeries', 0, -1);
        const timeSeries = timeSeriesData.map((entry) => JSON.parse(entry));
        res.json(timeSeries);
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.get('/youtube', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (typeof req.query.q === 'string') {
        try {
            yield redis_1.redisCount('youtubeSearch');
            const items = yield youtube_1.searchYoutube(req.query.q);
            res.json(items);
        }
        catch (_c) {
            return res.status(500).json({ error: 'youtube error' });
        }
    }
    else {
        return res.status(500).json({ error: 'query must be a string' });
    }
}));
app.post('/createRoom', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _d, _e, _f;
    const genName = () => '/' + (config_1.default.SHARD ? `${config_1.default.SHARD}-` : '') + names.choose();
    let name = genName();
    // Keep retrying until no collision
    while (rooms.has(name)) {
        name = genName();
    }
    console.log('createRoom: ', name);
    const newRoom = new room_1.Room(io, name);
    const decoded = yield firebase_1.validateUserToken((_d = req.body) === null || _d === void 0 ? void 0 : _d.uid, (_e = req.body) === null || _e === void 0 ? void 0 : _e.token);
    newRoom.creator = decoded === null || decoded === void 0 ? void 0 : decoded.email;
    newRoom.video = ((_f = req.body) === null || _f === void 0 ? void 0 : _f.video) || '';
    rooms.set(name, newRoom);
    newRoom.saveToRedis(false);
    if (config_1.default.ENABLE_POSTGRES_SAVING && postgres) {
        const roomObj = {
            roomId: newRoom.roomId,
            creationTime: newRoom.creationTime,
        };
        yield postgres_1.insertObject(postgres, 'room', roomObj);
    }
    res.json({ name: name.slice(1) });
}));
app.get('/settings', (req, res) => {
    if (req.hostname === config_1.default.CUSTOM_SETTINGS_HOSTNAME) {
        return res.json({
            mediaPath: config_1.default.MEDIA_PATH,
            streamPath: config_1.default.STREAM_PATH,
        });
    }
    return res.json({});
});
app.post('/manageSub', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _g, _h, _j;
    const decoded = yield firebase_1.validateUserToken((_g = req.body) === null || _g === void 0 ? void 0 : _g.uid, (_h = req.body) === null || _h === void 0 ? void 0 : _h.token);
    if (!decoded) {
        return res.status(400).json({ error: 'invalid user token' });
    }
    if (!decoded.email) {
        return res.status(400).json({ error: 'no email found' });
    }
    const customer = yield stripe_1.getCustomerByEmail(decoded.email);
    if (!customer) {
        return res.status(400).json({ error: 'customer not found' });
    }
    const session = yield stripe_1.createSelfServicePortal(customer.id, (_j = req.body) === null || _j === void 0 ? void 0 : _j.return_url);
    return res.json(session);
}));
app.get('/metadata', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _k, _l, _m, _o;
    const decoded = yield firebase_1.validateUserToken((_k = req.query) === null || _k === void 0 ? void 0 : _k.uid, (_l = req.query) === null || _l === void 0 ? void 0 : _l.token);
    const isVMPoolFull = (vmManagers === null || vmManagers === void 0 ? void 0 : vmManagers.standard) ? Boolean(yield (redis === null || redis === void 0 ? void 0 : redis.get(vmManagers.standard.getRedisVMPoolFullKey())))
        : false;
    let isCustomer = false;
    let isSubscriber = false;
    if (decoded === null || decoded === void 0 ? void 0 : decoded.email) {
        const customer = yield stripe_1.getCustomerByEmail(decoded.email);
        isSubscriber = Boolean((_o = (_m = customer === null || customer === void 0 ? void 0 : customer.subscriptions) === null || _m === void 0 ? void 0 : _m.data) === null || _o === void 0 ? void 0 : _o.find((sub) => (sub === null || sub === void 0 ? void 0 : sub.status) === 'active'));
        isCustomer = Boolean(customer);
    }
    return res.json({ isSubscriber, isCustomer, isVMPoolFull });
}));
app.get('/resolveRoom/:vanity', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _p;
    const vanity = req.params.vanity;
    const result = yield (postgres === null || postgres === void 0 ? void 0 : postgres.query(`SELECT "roomId", vanity from room WHERE LOWER(vanity) = $1`, [(_p = vanity === null || vanity === void 0 ? void 0 : vanity.toLowerCase()) !== null && _p !== void 0 ? _p : '']));
    // console.log(vanity, result.rows);
    // We also use this for checking name availability, so just return empty response if it doesn't exist (http 200)
    return res.json(result === null || result === void 0 ? void 0 : result.rows[0]);
}));
app.get('/listRooms', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _q, _r, _s;
    const decoded = yield firebase_1.validateUserToken((_q = req.query) === null || _q === void 0 ? void 0 : _q.uid, (_r = req.query) === null || _r === void 0 ? void 0 : _r.token);
    if (!decoded) {
        return res.status(400).json({ error: 'invalid user token' });
    }
    const result = yield (postgres === null || postgres === void 0 ? void 0 : postgres.query(`SELECT "roomId", vanity from room WHERE owner = $1`, [decoded.uid]));
    return res.json((_s = result === null || result === void 0 ? void 0 : result.rows) !== null && _s !== void 0 ? _s : []);
}));
app.delete('/deleteRoom', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _t, _u;
    const decoded = yield firebase_1.validateUserToken((_t = req.query) === null || _t === void 0 ? void 0 : _t.uid, (_u = req.query) === null || _u === void 0 ? void 0 : _u.token);
    if (!decoded) {
        return res.status(400).json({ error: 'invalid user token' });
    }
    const result = yield (postgres === null || postgres === void 0 ? void 0 : postgres.query(`DELETE from room WHERE owner = $1 and "roomId" = $2`, [decoded.uid, req.query.roomId]));
    return res.json(result === null || result === void 0 ? void 0 : result.rows);
}));
app.get('/kv', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.query.key === config_1.default.KV_KEY && redis) {
        return res.end(yield redis.get(('kv:' + req.query.k)));
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.post('/kv', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.query.key === config_1.default.KV_KEY && redis) {
        return res.end(yield redis.setex('kv:' + req.query.k, 24 * 60 * 60, req.query.v));
    }
    else {
        return res.status(403).json({ error: 'Access Denied' });
    }
}));
app.use(express_1.default.static(config_1.default.BUILD_DIRECTORY));
// Send index.html for all other requests (SPA)
app.use('/*', (_req, res) => {
    res.sendFile(path_1.default.resolve(__dirname + `/../${config_1.default.BUILD_DIRECTORY}/index.html`));
});
function saveRooms() {
    return __awaiter(this, void 0, void 0, function* () {
        while (true) {
            // console.time('roomSave');
            const roomArr = Array.from(rooms.values());
            for (let i = 0; i < roomArr.length; i++) {
                if (roomArr[i].roster.length) {
                    yield roomArr[i].saveToRedis(null);
                    // await roomArr[i].saveToPostgres();
                }
            }
            // console.timeEnd('roomSave');
            yield new Promise((resolve) => setTimeout(resolve, 1000));
        }
    });
}
let currBatch = 0;
function release() {
    return __awaiter(this, void 0, void 0, function* () {
        // Reset VMs in rooms that are:
        // older than the session limit
        // assigned to a room with no users
        const roomArr = Array.from(rooms.values()).filter((room) => {
            return string_1.hashString(room.roomId) % releaseBatches === currBatch;
        });
        console.log('[RELEASE][%s] %s rooms in batch', currBatch, roomArr.length);
        for (let i = 0; i < roomArr.length; i++) {
            const room = roomArr[i];
            if (room.vBrowser && room.vBrowser.assignTime) {
                const maxTime = utils_1.getSessionLimitSeconds(room.vBrowser.large) * 1000;
                const elapsed = Number(new Date()) - room.vBrowser.assignTime;
                const ttl = maxTime - elapsed;
                const isTimedOut = ttl && ttl < releaseInterval;
                const isAlmostTimedOut = ttl && ttl < releaseInterval * 2;
                const isRoomEmpty = room.roster.length === 0;
                if (isTimedOut || isRoomEmpty) {
                    console.log('[RELEASE][%s] VM in room:', currBatch, room.roomId);
                    room.stopVBrowserInternal();
                    if (isTimedOut) {
                        room.addChatMessage(null, {
                            id: '',
                            system: true,
                            cmd: 'vBrowserTimeout',
                            msg: '',
                        });
                        redis_1.redisCount('vBrowserTerminateTimeout');
                    }
                    else if (isRoomEmpty) {
                        redis_1.redisCount('vBrowserTerminateEmpty');
                    }
                }
                else if (isAlmostTimedOut) {
                    room.addChatMessage(null, {
                        id: '',
                        system: true,
                        cmd: 'vBrowserAlmostTimeout',
                        msg: '',
                    });
                }
            }
        }
        currBatch = (currBatch + 1) % releaseBatches;
    });
}
function minuteMetrics() {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const roomArr = Array.from(rooms.values());
        for (let i = 0; i < roomArr.length; i++) {
            const room = roomArr[i];
            if (room.vBrowser && room.vBrowser.id) {
                // Renew the locks
                yield (redis === null || redis === void 0 ? void 0 : redis.expire('lock:' + room.vBrowser.provider + ':' + room.vBrowser.id, 300));
                yield (redis === null || redis === void 0 ? void 0 : redis.expire('vBrowserUIDLock:' + room.vBrowser.creatorUID, 120));
                const expireTime = time_1.getStartOfDay() / 1000 + 86400;
                if ((_a = room.vBrowser) === null || _a === void 0 ? void 0 : _a.creatorClientID) {
                    yield (redis === null || redis === void 0 ? void 0 : redis.zincrby('vBrowserClientIDMinutes', 1, room.vBrowser.creatorClientID));
                    yield (redis === null || redis === void 0 ? void 0 : redis.expireat('vBrowserClientIDMinutes', expireTime));
                }
                if ((_b = room.vBrowser) === null || _b === void 0 ? void 0 : _b.creatorUID) {
                    yield (redis === null || redis === void 0 ? void 0 : redis.zincrby('vBrowserUIDMinutes', 1, room.vBrowser.creatorUID));
                    yield (redis === null || redis === void 0 ? void 0 : redis.expireat('vBrowserUIDMinutes', expireTime));
                }
            }
        }
    });
}
function cleanupRooms() {
    return __awaiter(this, void 0, void 0, function* () {
        // Clean up rooms that are no longer in Redis (expired) and empty
        // Frees up some JS memory space when process is long-running
        if (!redis) {
            return;
        }
        const permanentRooms = yield getPermanentRooms();
        const permanentSet = new Set(permanentRooms.map((room) => room.roomId));
        rooms.forEach((room, key) => __awaiter(this, void 0, void 0, function* () {
            if (room.roster.length === 0) {
                const inRedis = yield (redis === null || redis === void 0 ? void 0 : redis.get(room.roomId));
                if (!inRedis && !permanentSet.has(room.roomId)) {
                    room.destroy();
                    rooms.delete(key);
                }
            }
        }));
    });
}
function getPermanentRooms() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!postgres) {
            return [];
        }
        return (yield postgres.query(`SELECT * from room where "roomId" SIMILAR TO '${config_1.default.SHARD ? `/${config_1.default.SHARD}-[a-z]%` : '/[a-z]%'}' AND owner IS NOT NULL`)).rows;
    });
}
function getStats() {
    var _a, _b, _c, _d;
    return __awaiter(this, void 0, void 0, function* () {
        const now = Number(new Date());
        const currentRoomData = [];
        let currentUsers = 0;
        let currentHttp = 0;
        let currentVBrowser = 0;
        let currentVBrowserLarge = 0;
        let currentVBrowserWaiting = 0;
        let currentScreenShare = 0;
        let currentFileShare = 0;
        let currentVideoChat = 0;
        let currentRoomSizeCounts = {};
        let currentVBrowserUIDCounts = {};
        let currentRoomCount = rooms.size;
        const vmManager = vmManagers.standard;
        const vmManagerLarge = vmManagers.large;
        rooms.forEach((room) => {
            var _a, _b, _c, _d, _e;
            const obj = {
                creationTime: room.creationTime,
                lastUpdateTime: room.lastUpdateTime,
                roomId: room.roomId,
                video: room.video,
                videoTS: room.videoTS,
                rosterLength: room.roster.length,
                roster: room.getRosterForStats(),
                videoChats: room.roster.filter((p) => p.isVideoChat).length,
                vBrowser: room.vBrowser,
                vBrowserElapsed: ((_a = room.vBrowser) === null || _a === void 0 ? void 0 : _a.assignTime) && now - ((_b = room.vBrowser) === null || _b === void 0 ? void 0 : _b.assignTime),
                lock: room.lock || undefined,
                creator: room.creator || undefined,
            };
            currentUsers += obj.rosterLength;
            currentVideoChat += obj.videoChats;
            if (obj.vBrowser) {
                currentVBrowser += 1;
            }
            if (obj.vBrowser && obj.vBrowser.large) {
                currentVBrowserLarge += 1;
            }
            if (room.roomRedis) {
                currentVBrowserWaiting += 1;
            }
            if (((_c = obj.video) === null || _c === void 0 ? void 0 : _c.startsWith('http')) && obj.rosterLength) {
                currentHttp += 1;
            }
            if (((_d = obj.video) === null || _d === void 0 ? void 0 : _d.startsWith('screenshare://')) && obj.rosterLength) {
                currentScreenShare += 1;
            }
            if (((_e = obj.video) === null || _e === void 0 ? void 0 : _e.startsWith('fileshare://')) && obj.rosterLength) {
                currentFileShare += 1;
            }
            if (obj.rosterLength > 0) {
                if (!currentRoomSizeCounts[obj.rosterLength]) {
                    currentRoomSizeCounts[obj.rosterLength] = 0;
                }
                currentRoomSizeCounts[obj.rosterLength] += 1;
            }
            if (obj.vBrowser && obj.vBrowser.creatorUID) {
                if (!currentVBrowserUIDCounts[obj.vBrowser.creatorUID]) {
                    currentVBrowserUIDCounts[obj.vBrowser.creatorUID] = 0;
                }
                currentVBrowserUIDCounts[obj.vBrowser.creatorUID] += 1;
            }
            if (obj.video) {
                currentRoomData.push(obj);
            }
        });
        currentVBrowserUIDCounts = Object.fromEntries(Object.entries(currentVBrowserUIDCounts).filter(([, val]) => val > 1));
        // Sort newest first
        currentRoomData.sort((a, b) => b.creationTime - a.creationTime);
        const uptime = Number(new Date()) - launchTime;
        const cpuUsage = os_1.default.loadavg();
        const memUsage = process.memoryUsage().rss;
        const redisUsage = (_b = (_a = (yield (redis === null || redis === void 0 ? void 0 : redis.info()))) === null || _a === void 0 ? void 0 : _a.split('\n').find((line) => line.startsWith('used_memory:'))) === null || _b === void 0 ? void 0 : _b.split(':')[1].trim();
        const availableVBrowsers = yield (redis === null || redis === void 0 ? void 0 : redis.lrange((vmManager === null || vmManager === void 0 ? void 0 : vmManager.getRedisQueueKey()) || 'availableList', 0, -1));
        const stagingVBrowsers = yield (redis === null || redis === void 0 ? void 0 : redis.lrange((vmManager === null || vmManager === void 0 ? void 0 : vmManager.getRedisStagingKey()) || 'stagingList', 0, -1));
        const availableVBrowsersLarge = yield (redis === null || redis === void 0 ? void 0 : redis.lrange((vmManagerLarge === null || vmManagerLarge === void 0 ? void 0 : vmManagerLarge.getRedisQueueKey()) || 'availableList', 0, -1));
        const stagingVBrowsersLarge = yield (redis === null || redis === void 0 ? void 0 : redis.lrange((vmManagerLarge === null || vmManagerLarge === void 0 ? void 0 : vmManagerLarge.getRedisStagingKey()) || 'stagingList', 0, -1));
        const numPermaRooms = (_c = (yield (postgres === null || postgres === void 0 ? void 0 : postgres.query('SELECT count(1) from room')))) === null || _c === void 0 ? void 0 : _c.rows[0].count;
        const numSubs = (_d = (yield (postgres === null || postgres === void 0 ? void 0 : postgres.query('SELECT count(1) from subscriber')))) === null || _d === void 0 ? void 0 : _d.rows[0].count;
        const chatMessages = yield redis_1.getRedisCountDay('chatMessages');
        const vBrowserStarts = yield redis_1.getRedisCountDay('vBrowserStarts');
        const vBrowserLaunches = yield redis_1.getRedisCountDay('vBrowserLaunches');
        const vBrowserFails = yield redis_1.getRedisCountDay('vBrowserFails');
        const vBrowserStagingFails = yield redis_1.getRedisCountDay('vBrowserStagingFails');
        const vBrowserStartMS = yield (redis === null || redis === void 0 ? void 0 : redis.lrange('vBrowserStartMS', 0, -1));
        const vBrowserStageRetries = yield (redis === null || redis === void 0 ? void 0 : redis.lrange('vBrowserStageRetries', 0, -1));
        const vBrowserSessionMS = yield (redis === null || redis === void 0 ? void 0 : redis.lrange('vBrowserSessionMS', 0, -1));
        const vBrowserVMLifetime = yield (redis === null || redis === void 0 ? void 0 : redis.lrange('vBrowserVMLifetime', 0, -1));
        const vBrowserTerminateTimeout = yield redis_1.getRedisCountDay('vBrowserTerminateTimeout');
        const vBrowserTerminateEmpty = yield redis_1.getRedisCountDay('vBrowserTerminateEmpty');
        const vBrowserTerminateManual = yield redis_1.getRedisCountDay('vBrowserTerminateManual');
        const recaptchaRejectsLowScore = yield redis_1.getRedisCountDay('recaptchaRejectsLowScore');
        const recaptchaRejectsOther = yield redis_1.getRedisCountDay('recaptchaRejectsOther');
        const urlStarts = yield redis_1.getRedisCountDay('urlStarts');
        const playlistAdds = yield redis_1.getRedisCountDay('playlistAdds');
        const screenShareStarts = yield redis_1.getRedisCountDay('screenShareStarts');
        const fileShareStarts = yield redis_1.getRedisCountDay('fileShareStarts');
        const videoChatStarts = yield redis_1.getRedisCountDay('videoChatStarts');
        const connectStarts = yield redis_1.getRedisCountDay('connectStarts');
        const connectStartsDistinct = yield redis_1.getRedisCountDayDistinct('connectStartsDistinct');
        const subUploads = yield redis_1.getRedisCountDay('subUploads');
        const youtubeSearch = yield redis_1.getRedisCountDay('youtubeSearch');
        const vBrowserClientIDs = yield (redis === null || redis === void 0 ? void 0 : redis.zrevrangebyscore('vBrowserClientIDs', '+inf', '0', 'WITHSCORES', 'LIMIT', 0, 20));
        const vBrowserUIDs = yield (redis === null || redis === void 0 ? void 0 : redis.zrevrangebyscore('vBrowserUIDs', '+inf', '0', 'WITHSCORES', 'LIMIT', 0, 20));
        const vBrowserClientIDMinutes = yield (redis === null || redis === void 0 ? void 0 : redis.zrevrangebyscore('vBrowserClientIDMinutes', '+inf', '0', 'WITHSCORES', 'LIMIT', 0, 20));
        const vBrowserUIDMinutes = yield (redis === null || redis === void 0 ? void 0 : redis.zrevrangebyscore('vBrowserUIDMinutes', '+inf', '0', 'WITHSCORES', 'LIMIT', 0, 20));
        const vBrowserClientIDsCard = yield (redis === null || redis === void 0 ? void 0 : redis.zcard('vBrowserClientIDs'));
        const vBrowserUIDsCard = yield (redis === null || redis === void 0 ? void 0 : redis.zcard('vBrowserUIDs'));
        return {
            uptime,
            cpuUsage,
            memUsage,
            redisUsage,
            currentRoomCount,
            currentRoomSizeCounts,
            currentUsers,
            currentVBrowser,
            currentVBrowserLarge,
            currentVBrowserWaiting,
            currentHttp,
            currentScreenShare,
            currentFileShare,
            currentVideoChat,
            currentVBrowserUIDCounts,
            numPermaRooms,
            numSubs,
            chatMessages,
            urlStarts,
            playlistAdds,
            screenShareStarts,
            fileShareStarts,
            subUploads,
            youtubeSearch,
            videoChatStarts,
            connectStarts,
            connectStartsDistinct,
            vBrowserStarts,
            vBrowserLaunches,
            vBrowserFails,
            vBrowserStagingFails,
            vBrowserTerminateManual,
            vBrowserTerminateEmpty,
            vBrowserTerminateTimeout,
            recaptchaRejectsLowScore,
            recaptchaRejectsOther,
            availableVBrowsers,
            stagingVBrowsers,
            availableVBrowsersLarge,
            stagingVBrowsersLarge,
            vBrowserStartMS,
            vBrowserStageRetries,
            vBrowserSessionMS,
            vBrowserVMLifetime,
            vBrowserClientIDs,
            vBrowserClientIDsCard,
            vBrowserClientIDMinutes,
            vBrowserUIDs,
            vBrowserUIDsCard,
            vBrowserUIDMinutes,
            currentRoomData,
        };
    });
}
