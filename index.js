const uuid = require("uuid").v4;
const Errors = require("./errors");

function Main(cnf, deps) {
  const {
    _,
    logger,
    graceful,
    U: { tryCatchLog },
  } = deps;
  const maxListeners = Math.max(1, ((cnf.mcenter && cnf.mcenter.maxListeners) || 10) | 0);
  const { async } = deps;

  const errors = Errors(cnf, deps);
  // 默认通知函数
  const fns = {
    error: logger.error,
    timeout: logger.info,
  };

  // 记录已注册的消息
  // { [name]: { validator, types } };
  // name: String 消息名称
  // validator?: Function 消息体数据格式验证函数
  // types: [{
  //    type: 'updateUser', // 类型名称
  //    timeout?: 100, // 执行超时限定, 单位毫秒，可选 默认为 0, 不限制
  //    validator?: fn, // 返回值格式验证函数, 可选
  // }]
  const registed = {};

  // 记录监听回调函数
  // { [${name}::${type}]: { [type]: fn } }
  const listeners = new Map();

  // 消息分发函数，分发到对应的订阅函数上
  const dispatch = async ({ name, data, callback }) => {
    const { types } = registed[name];
    const result = {};

    await async.mapSeries(types, async ({ type, timeout, validator }) => {
      const fn = listeners.get(`${name}::${type}`);
      const startAt = Date.now();
      let err = null;
      let ret = null;
      try {
        ret = await fn(data);
        if (validator) validator(ret);
      } catch (e) {
        fns.error(e, name, data, type);
        err = e;
      }
      const consumedMS = Date.now() - startAt;
      if (timeout && timeout < consumedMS) fns.timeout(consumedMS, name, data, type);
      result[type] = [err, ret, consumedMS];
    });

    if (callback) callback(result);
  };

  // 内部消息队列
  const queue = async.queue(dispatch, maxListeners);

  // regist 消息注册，提前注册好需要publish和subscribe的消息
  // 这么做的目的是可以随时检测是否所有的消息都消费者，消费者类型是否正确
  // 同时在publish的时候也可以检测发送的数据是否符合规定的格式
  const regist = (name, validator, types) => {
    if (registed[name]) throw errors.duplicatRegistMessage(name);
    registed[name] = { validator, types, typeNames: new Set(_.map(types, "type")) };
  };

  // subscribe 消息订阅
  const subscribe = (name, type, listener) => {
    if (!registed[name]) throw errors.subscribeUnregistedMessage(name);
    const { typeNames } = registed[name];
    if (!typeNames.has(type)) throw errors.subscribeUnknowTypes(name, type);

    listeners.set(`${name}::${type}`, listener);
  };

  // publish 消息发布
  // name string 消息名称
  // data any 消息数据
  // callback function 消息执行完毕回调
  const publish = (name, data, callback) => {
    if (!registed[name]) throw errors.publishUnregistedMessage(name);
    const { validator } = registed[name];
    if (validator) validator(data);
    const id = uuid();
    queue.push({ id, name, data, callback });
  };

  // 设置通知函数，错误通知，超时通知
  // 在消息分发执行的时候遇到错误会调用错误通知函数
  // 在消息分发执行的时候遇到超时会调用超时通知函数
  // type string 类型，error or timeout
  // fn function 通知函数
  const setFn = (type, fn) => {
    if (!fns[type]) throw errors.setFnNotAllowed(type);
    // 这里之所以会用 tryCatchLog 封装函数，是不想让这些函数的执行影响主流程
    // 这些函数内部抛出的异常不会导致主流程执行中断
    fns[type] = tryCatchLog(fn, logger.error);
  };

  // check 消息注册、监听检测
  // 检查是否存在注册了的消息，但没有人监听消费
  const check = () => {
    const result = [];
    for (const name of Object.keys(registed)) {
      for (const type of registed[name]) {
        if (listeners.get(`${name}::${type.type}`)) continue;
        result.push([name, type.type]);
      }
    }

    return result;
  };

  return { regist, check, subscribe, publish, setFn };
}

Main.Deps = ["_", "async", "logger", "utils"];

module.exports = Main;
