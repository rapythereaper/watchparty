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
exports.VMManager = void 0;
const config_1 = __importDefault(require("../config"));
const ioredis_1 = __importDefault(require("ioredis"));
const axios_1 = __importDefault(require("axios"));
const uuid_1 = require("uuid");
const redis_1 = require("../utils/redis");
let redis = undefined;
if (config_1.default.REDIS_URL) {
    redis = new ioredis_1.default(config_1.default.REDIS_URL);
}
const incrInterval = 10 * 1000;
const decrInterval = 1 * 60 * 1000;
const cleanupInterval = 5 * 60 * 1000;
const updateSizeInterval = 30 * 1000;
class VMManager {
    constructor(large, region = '') {
        this.isLarge = false;
        this.region = '';
        this.currentSize = 0;
        this.getMinSize = () => this.isLarge
            ? Number(config_1.default.VM_POOL_MIN_SIZE_LARGE)
            : Number(config_1.default.VM_POOL_MIN_SIZE);
        this.getLimitSize = () => this.isLarge
            ? Number(config_1.default.VM_POOL_LIMIT_LARGE)
            : Number(config_1.default.VM_POOL_LIMIT);
        this.getCurrentSize = () => {
            return this.currentSize;
        };
        this.getRedisQueueKey = () => {
            return ('availableList' + this.id + this.region + (this.isLarge ? 'Large' : ''));
        };
        this.getRedisStagingKey = () => {
            return ('stagingList' + this.id + this.region + (this.isLarge ? 'Large' : ''));
        };
        this.getRedisHostCacheKey = () => {
            return 'hostCache' + this.id + this.region + (this.isLarge ? 'Large' : '');
        };
        this.getRedisVMPoolFullKey = () => {
            return 'vmPoolFull' + this.id + this.region + (this.isLarge ? 'Large' : '');
        };
        this.getTag = () => {
            return ((config_1.default.VBROWSER_TAG || 'vbrowser') +
                this.region +
                (this.isLarge ? 'Large' : ''));
        };
        this.resetVM = (id) => __awaiter(this, void 0, void 0, function* () {
            console.log('[RESET]', id);
            // We can attempt to reuse the instance which is more efficient if users tend to use them for a short time
            // Otherwise terminating them is simpler but more expensive since they're billed for an hour
            yield this.rebootVM(id);
            // Delete any locks
            yield this.redis.del('lock:' + this.id + ':' + id);
            // We wait to give the VM time to shut down (if it's restarting)
            yield new Promise((resolve) => setTimeout(resolve, 3000));
            // Add the VM back to the pool
            yield this.redis.rpush(this.getRedisStagingKey(), id);
        });
        this.startVMWrapper = () => __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            // generate credentials and boot a VM
            try {
                const password = uuid_1.v4();
                const id = yield this.startVM(password);
                yield this.redis.rpush(this.getRedisStagingKey(), id);
                redis_1.redisCount('vBrowserLaunches');
                return id;
            }
            catch (e) {
                console.log((_a = e.response) === null || _a === void 0 ? void 0 : _a.status, JSON.stringify((_b = e.response) === null || _b === void 0 ? void 0 : _b.data), (_c = e.config) === null || _c === void 0 ? void 0 : _c.url, (_d = e.config) === null || _d === void 0 ? void 0 : _d.data);
            }
        });
        this.terminateVMWrapper = (id) => __awaiter(this, void 0, void 0, function* () {
            console.log('[TERMINATE]', id);
            // Remove from lists, if it exists
            yield this.redis.lrem(this.getRedisQueueKey(), 0, id);
            yield this.redis.lrem(this.getRedisStagingKey(), 0, id);
            // Get the VM data to calculate lifetime, if we fail do the terminate anyway
            const lifetime = yield this.terminateVMMetrics(id);
            yield this.terminateVM(id);
            if (lifetime) {
                yield this.redis.lpush('vBrowserVMLifetime', lifetime);
                yield this.redis.ltrim('vBrowserVMLifetime', 0, 49);
            }
            // Delete any locks
            yield this.redis.del('lock:' + this.id + ':' + id);
            yield this.redis.del(this.getRedisHostCacheKey() + ':' + id);
        });
        this.terminateVMMetrics = (id) => __awaiter(this, void 0, void 0, function* () {
            try {
                const vm = yield this.getVM(id);
                if (vm) {
                    const lifetime = Number(new Date()) - Number(new Date(vm.creation_date));
                    return lifetime;
                }
            }
            catch (e) {
                console.warn(e);
            }
            return 0;
        });
        this.runBackgroundJobs = () => {
            console.log('[VMWORKER] starting background jobs for %s', this.getRedisQueueKey());
            let vmBufferSize = 0;
            let vmBufferFlex = 0;
            if (this.isLarge) {
                vmBufferSize = Number(config_1.default.VBROWSER_VM_BUFFER_LARGE) || 0;
                vmBufferFlex = Number(config_1.default.VBROWSER_VM_BUFFER_LARGE_FLEX) || 0;
            }
            else {
                vmBufferSize = Number(config_1.default.VBROWSER_VM_BUFFER) || 0;
                vmBufferFlex = Number(config_1.default.VBROWSER_VM_BUFFER_FLEX) || 0;
            }
            const vmBufferMax = vmBufferSize + vmBufferFlex;
            const resizeVMGroupIncr = () => __awaiter(this, void 0, void 0, function* () {
                const availableCount = yield this.redis.llen(this.getRedisQueueKey());
                const stagingCount = yield this.redis.llen(this.getRedisStagingKey());
                let launch = false;
                launch =
                    availableCount + stagingCount < vmBufferSize &&
                        this.getCurrentSize() < (this.getLimitSize() || Infinity);
                if (launch) {
                    console.log('[RESIZE-LAUNCH]', 'desired:', vmBufferSize, 'available:', availableCount, 'staging:', stagingCount, 'currentSize:', this.getCurrentSize(), 'limit:', this.getLimitSize());
                    this.startVMWrapper();
                }
            });
            const resizeVMGroupDecr = () => __awaiter(this, void 0, void 0, function* () {
                let unlaunch = false;
                const availableCount = yield this.redis.llen(this.getRedisQueueKey());
                unlaunch = availableCount > vmBufferMax;
                if (unlaunch) {
                    const allVMs = yield this.listVMs(this.getTag());
                    const now = Date.now();
                    let sortedVMs = allVMs
                        // Sort newest first (decreasing alphabetically)
                        .sort((a, b) => { var _a; return -((_a = a.creation_date) === null || _a === void 0 ? void 0 : _a.localeCompare(b.creation_date)); })
                        // Remove the minimum number of VMs to keep
                        .slice(0, -this.getMinSize() || undefined)
                        // Consider only VMs that have been up for most of an hour
                        .filter((vm) => (now - Number(new Date(vm.creation_date))) % (60 * 60 * 1000) >
                        config_1.default.VM_MIN_UPTIME_MINUTES * 60 * 1000);
                    let first = null;
                    let rem = 0;
                    // Remove the first available VM
                    while (sortedVMs.length && !rem) {
                        first = sortedVMs.shift();
                        const id = first === null || first === void 0 ? void 0 : first.id;
                        rem = id ? yield this.redis.lrem(this.getRedisQueueKey(), 1, id) : 0;
                    }
                    if (first && rem) {
                        const id = first === null || first === void 0 ? void 0 : first.id;
                        console.log('[RESIZE-UNLAUNCH]', id);
                        yield this.terminateVMWrapper(id);
                    }
                }
            });
            const updateSize = () => __awaiter(this, void 0, void 0, function* () {
                const allVMs = yield this.listVMs(this.getTag());
                this.currentSize = allVMs.length;
                const availableCount = yield this.redis.llen(this.getRedisQueueKey());
                if (config_1.default.VM_POOL_LIMIT &&
                    this.currentSize >= config_1.default.VM_POOL_LIMIT &&
                    availableCount === 0) {
                    yield this.redis.setex(this.getRedisVMPoolFullKey(), 2 * 60, this.currentSize);
                }
                else {
                    yield this.redis.del(this.getRedisVMPoolFullKey() + this.id);
                }
            });
            const cleanupVMGroup = () => __awaiter(this, void 0, void 0, function* () {
                // Clean up hanging VMs
                // It's possible we created a VM but lost track of it in redis
                // Take the list of VMs from API, subtract VMs that have a lock in redis or are in the available or staging pool, delete the rest
                const allVMs = yield this.listVMs(this.getTag());
                const usedKeys = [];
                for (let i = 0; i < allVMs.length; i++) {
                    if (yield (redis === null || redis === void 0 ? void 0 : redis.get(`lock:${this.id}:${allVMs[i].id}`))) {
                        usedKeys.push(allVMs[i].id);
                    }
                }
                const availableKeys = yield this.redis.lrange(this.getRedisQueueKey(), 0, -1);
                const stagingKeys = yield this.redis.lrange(this.getRedisStagingKey(), 0, -1);
                const dontDelete = new Set([
                    ...usedKeys,
                    ...availableKeys,
                    ...stagingKeys,
                ]);
                console.log('[CLEANUP] found %s VMs, usedKeys %s, availableKeys %s, stagingKeys %s', allVMs.length, usedKeys.length, availableKeys.length, stagingKeys.length);
                for (let i = 0; i < allVMs.length; i++) {
                    const server = allVMs[i];
                    if (!dontDelete.has(server.id)) {
                        console.log('[CLEANUP]', server.id);
                        //this.resetVM(server.id);
                        this.terminateVM(server.id);
                    }
                }
            });
            const checkStaging = () => __awaiter(this, void 0, void 0, function* () {
                const checkStagingInterval = 2000;
                while (true) {
                    // console.log('[CHECKSTAGING-START]', Math.floor(Date.now() / 1000));
                    try {
                        // Loop through staging list and check if VM is ready
                        const stagingKeys = yield this.redis.lrange(this.getRedisStagingKey(), 0, -1);
                        const stagingPromises = stagingKeys.map((id) => {
                            new Promise((resolve) => __awaiter(this, void 0, void 0, function* () {
                                var _a, _b;
                                const retryCount = yield this.redis.incr(this.getRedisStagingKey() + ':' + id);
                                let ready = false;
                                let host = yield this.redis.get(this.getRedisHostCacheKey() + ':' + id);
                                if (!host) {
                                    try {
                                        const vm = yield this.getVM(id);
                                        host = (_a = vm === null || vm === void 0 ? void 0 : vm.host) !== null && _a !== void 0 ? _a : null;
                                    }
                                    catch (e) {
                                        if (((_b = e.response) === null || _b === void 0 ? void 0 : _b.status) === 404) {
                                            yield this.redis.lrem(this.getRedisQueueKey(), 0, id);
                                            yield this.redis.lrem(this.getRedisStagingKey(), 0, id);
                                            yield this.redis.del(this.getRedisStagingKey() + ':' + id);
                                            return resolve();
                                        }
                                    }
                                    if (host) {
                                        console.log('[CHECKSTAGING] caching host %s for id %s', host, id);
                                        yield this.redis.setex(this.getRedisHostCacheKey() + ':' + id, 3600, host);
                                    }
                                }
                                //ready = await checkVMReady(host ?? '');
                                ready = retryCount > 100;
                                if (ready) {
                                    console.log('[CHECKSTAGING] ready:', id, host, retryCount);
                                    // If it is, move it to available list
                                    const rem = yield this.redis.lrem(this.getRedisStagingKey(), 1, id);
                                    if (rem) {
                                        yield this.redis
                                            .multi()
                                            .rpush(this.getRedisQueueKey(), id)
                                            .del(this.getRedisStagingKey() + ':' + id)
                                            .exec();
                                        yield this.redis.lpush('vBrowserStageRetries', retryCount);
                                        yield this.redis.ltrim('vBrowserStageRetries', 0, 49);
                                    }
                                }
                                else {
                                    if (retryCount >= 500) {
                                        console.log('[CHECKSTAGING] giving up:', id);
                                        yield this.redis
                                            .multi()
                                            .lrem(this.getRedisStagingKey(), 0, id)
                                            .del(this.getRedisStagingKey() + ':' + id)
                                            .exec();
                                        redis_1.redisCount('vBrowserStagingFails');
                                        yield this.resetVM(id);
                                    }
                                    else {
                                        if (retryCount % 100 === 0) {
                                            const vm = yield this.getVM(id);
                                            console.log('[CHECKSTAGING] %s attempt to poweron and attach to network', id);
                                            this.powerOn(id);
                                            if (!(vm === null || vm === void 0 ? void 0 : vm.private_ip)) {
                                                this.attachToNetwork(id);
                                            }
                                        }
                                        if (retryCount % 10 === 0) {
                                            console.log('[CHECKSTAGING] not ready:', id, host, retryCount);
                                        }
                                    }
                                }
                                resolve();
                            }));
                        });
                        yield Promise.allSettled(stagingPromises);
                    }
                    catch (e) {
                        console.warn('[CHECKSTAGING-ERROR]', e);
                    }
                    yield new Promise((resolve) => setTimeout(resolve, checkStagingInterval));
                }
            });
            const checkVMReady = (host) => __awaiter(this, void 0, void 0, function* () {
                var _a;
                const url = 'https://' + host.replace('/', '/healthz');
                try {
                    // const out = execSync(`curl -i -L -v --ipv4 '${host}'`);
                    // if (!out.toString().startsWith('OK') && !out.toString().startsWith('404 page not found')) {
                    //   throw new Error('mismatched response from healthz');
                    // }
                    yield axios_1.default({
                        method: 'GET',
                        url,
                        timeout: 30000,
                    });
                }
                catch (e) {
                    console.log(url, e.message, (_a = e.response) === null || _a === void 0 ? void 0 : _a.status);
                    return false;
                }
                return true;
            });
            setInterval(resizeVMGroupIncr, incrInterval);
            setInterval(resizeVMGroupDecr, decrInterval);
            updateSize();
            setInterval(updateSize, updateSizeInterval);
            cleanupVMGroup();
            setInterval(cleanupVMGroup, cleanupInterval);
            setTimeout(checkStaging, 100); // Add some delay to make sure the object is constructed first
        };
        this.isLarge = Boolean(large);
        this.region = region;
        if (!redis) {
            throw new Error('Cannot construct VMManager without Redis');
        }
        this.redis = redis;
    }
}
exports.VMManager = VMManager;
