// Sentinel the model returns when it decides NOT to jump into a group
// conversation on its own (autonomous "control yourself" mode). Chosen to be
// unlikely to appear in normal conversation.
module.exports = {
  AUTO_CHAT_SKIP_TOKEN: '[[NO_REPLY]]'
};
