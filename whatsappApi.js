const sessionManager = require('./sessionManager');
const db = require('./database');

async function checkPermission(userId, connectionId) {
  const conn = db.whatsapp_connections.get(connectionId);
  if (!conn || conn.user_id !== userId) throw new Error('Unauthorized or connection not found');
  const session = sessionManager.getSession(connectionId);
  if (!session) throw new Error('WhatsApp session not active');
  return session;
}

async function getGroups(userId, connectionId) {
  try {
    const session = await checkPermission(userId, connectionId);
    if (session.status !== 'connected') return { error: 'WhatsApp not connected' };
    const groups = await session.sock.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({ jid: g.id, name: g.subject, participants: g.participants.length }));
  } catch (err) { return { error: 'Failed to fetch groups', details: err.message }; }
}

async function getGroupMetadata(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    if (!jid || !jid.endsWith('@g.us')) return { error: 'A group JID is required' };
    const metadata = await session.sock.groupMetadata(jid);
    return { jid: metadata.id, subject: metadata.subject, owner: metadata.owner, participants: metadata.participants.map(p => ({ id: p.id, admin: p.admin || null })) };
  } catch (err) { return { error: 'Failed to fetch group metadata', details: err.message }; }
}

async function sendMessage(userId, connectionId, jid, text) {
  try {
    const session = await checkPermission(userId, connectionId);
    if (session.status !== 'connected') return { error: 'WhatsApp not connected' };
    const result = await session.sock.sendMessage(jid, { text });
    return { status: 'sent', messageId: result.key.id };
  } catch (err) { return { error: 'Failed to send message', details: err.message }; }
}

async function mention(userId, connectionId, jid, text, participant) {
  try {
    const session = await checkPermission(userId, connectionId);
    if (!jid.endsWith('@g.us')) return { error: 'Mentions are only supported in groups' };
    const result = await session.sock.sendMessage(jid, { text, mentions: [participant] });
    return { status: 'sent', messageId: result.key.id, mentioned: participant };
  } catch (err) { return { error: 'Failed to mention participant', details: err.message }; }
}

async function pinMessage(userId, connectionId, jid, messageId) {
  try {
    await checkPermission(userId, connectionId);
    return { status: 'unavailable', error: 'Pinning is not exposed by this Baileys integration; no simulated success is returned.' };
  } catch (err) { return { error: 'Pin action failed', details: err.message }; }
}

async function removeParticipant(userId, connectionId, jid, participant) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupParticipantsUpdate(jid, [participant], 'remove');
    return { status: 'success', action: 'remove_participant', participant };
  } catch (err) { return { error: 'Failed to remove participant', details: err.message }; }
}

async function addParticipant(userId, connectionId, jid, participant) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupParticipantsUpdate(jid, [participant], 'add');
    return { status: 'success', action: 'add_participant', participant };
  } catch (err) { return { error: 'Failed to add participant', details: err.message }; }
}

async function promoteParticipant(userId, connectionId, jid, participant) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupParticipantsUpdate(jid, [participant], 'promote');
    return { status: 'success', action: 'promote_participant', participant };
  } catch (err) { return { error: 'Failed to promote participant', details: err.message }; }
}

async function demoteParticipant(userId, connectionId, jid, participant) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupParticipantsUpdate(jid, [participant], 'demote');
    return { status: 'success', action: 'demote_participant', participant };
  } catch (err) { return { error: 'Failed to demote participant', details: err.message }; }
}

async function updateGroupSubject(userId, connectionId, jid, subject) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupUpdateSubject(jid, String(subject || '').slice(0, 100));
    return { status: 'success', action: 'update_group_subject', subject };
  } catch (err) { return { error: 'Failed to update group name', details: err.message }; }
}

async function updateGroupDescription(userId, connectionId, jid, description) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupUpdateDescription(jid, description);
    return { status: 'success', action: 'update_group_description' };
  } catch (err) { return { error: 'Failed to update group description', details: err.message }; }
}

async function updateGroupSetting(userId, connectionId, jid, setting) {
  const allowed = ['announcement', 'not_announcement', 'locked', 'unlocked'];
  if (!allowed.includes(setting)) return { error: `setting must be one of ${allowed.join(', ')}` };
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupSettingUpdate(jid, setting);
    return { status: 'success', action: 'update_group_setting', setting };
  } catch (err) { return { error: 'Failed to update group setting', details: err.message }; }
}

async function leaveGroup(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.groupLeave(jid);
    return { status: 'success', action: 'leave_group', jid };
  } catch (err) { return { error: 'Failed to leave group', details: err.message }; }
}

async function createGroup(userId, connectionId, subject, participants) {
  try {
    const session = await checkPermission(userId, connectionId);
    const list = Array.isArray(participants) ? participants : [];
    const group = await session.sock.groupCreate(String(subject || 'New group').slice(0, 100), list);
    return { status: 'success', action: 'create_group', jid: group.id };
  } catch (err) { return { error: 'Failed to create group', details: err.message }; }
}

async function getGroupInviteCode(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    const code = await session.sock.groupInviteCode(jid);
    return { status: 'success', inviteLink: `https://chat.whatsapp.com/${code}` };
  } catch (err) { return { error: 'Failed to get invite code', details: err.message }; }
}

async function revokeGroupInvite(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    const code = await session.sock.groupRevokeInvite(jid);
    return { status: 'success', inviteLink: `https://chat.whatsapp.com/${code}` };
  } catch (err) { return { error: 'Failed to revoke invite code', details: err.message }; }
}

async function blockContact(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.updateBlockStatus(jid, 'block');
    return { status: 'success', action: 'block_contact', jid };
  } catch (err) { return { error: 'Failed to block contact', details: err.message }; }
}

async function unblockContact(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.updateBlockStatus(jid, 'unblock');
    return { status: 'success', action: 'unblock_contact', jid };
  } catch (err) { return { error: 'Failed to unblock contact', details: err.message }; }
}

async function archiveChat(userId, connectionId, jid, archive) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.chatModify({ archive: !!archive }, jid);
    return { status: 'success', action: archive ? 'archive_chat' : 'unarchive_chat', jid };
  } catch (err) { return { error: 'Failed to update chat archive state', details: err.message }; }
}

async function muteChat(userId, connectionId, jid, muteHours) {
  try {
    const session = await checkPermission(userId, connectionId);
    const mute = muteHours ? Date.now() + Number(muteHours) * 60 * 60 * 1000 : null;
    await session.sock.chatModify({ mute }, jid);
    return { status: 'success', action: muteHours ? 'mute_chat' : 'unmute_chat', jid };
  } catch (err) { return { error: 'Failed to update chat mute state', details: err.message }; }
}

async function pinChat(userId, connectionId, jid, pin) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.chatModify({ pin: !!pin }, jid);
    return { status: 'success', action: pin ? 'pin_chat' : 'unpin_chat', jid };
  } catch (err) { return { error: 'Failed to update chat pin state', details: err.message }; }
}

async function deleteMessageForEveryone(userId, connectionId, jid, messageKey) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.sendMessage(jid, { delete: messageKey });
    return { status: 'success', action: 'delete_message' };
  } catch (err) { return { error: 'Failed to delete message', details: err.message }; }
}

async function updateProfileStatus(userId, connectionId, status) {
  try {
    const session = await checkPermission(userId, connectionId);
    await session.sock.updateProfileStatus(String(status || '').slice(0, 139));
    return { status: 'success', action: 'update_profile_status' };
  } catch (err) { return { error: 'Failed to update profile status', details: err.message }; }
}

async function getProfilePictureUrl(userId, connectionId, jid) {
  try {
    const session = await checkPermission(userId, connectionId);
    const url = await session.sock.profilePictureUrl(jid, 'image');
    return { status: 'success', url: url || null };
  } catch (err) { return { error: 'Failed to fetch profile picture', details: err.message }; }
}

module.exports = {
  getGroups, getGroupMetadata, sendMessage, mention, pinMessage, removeParticipant, addParticipant,
  promoteParticipant, demoteParticipant, updateGroupSubject, updateGroupDescription, updateGroupSetting,
  leaveGroup, createGroup, getGroupInviteCode, revokeGroupInvite, blockContact, unblockContact,
  archiveChat, muteChat, pinChat, deleteMessageForEveryone, updateProfileStatus, getProfilePictureUrl
};
