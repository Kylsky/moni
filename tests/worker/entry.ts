import { handlePrivateApi } from '../../src/worker';

export { Conversation } from '../../src/chat-do';
export { WechatBot } from '../../src/wechat-do';

export default { fetch: handlePrivateApi } satisfies ExportedHandler<Env>;
