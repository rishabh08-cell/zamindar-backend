const express = require('express');
const router = express.Router();
const {
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    removeFriend,
    getFriends,
    getPendingRequests,
} = require('../db/dost');
const {
    createFauj,
    getFaujById,
    getUserFauj,
    inviteToFauj,
    getPendingInvites,
    respondToInvite,
    leaveFauj,
    disbandFauj,
    listFaujs,
} = require('../db/fauj');
const {
    createDuel,
    acceptDuel,
    cancelDuel,
    getUserDuels,
} = require('../db/duels');
const { areInSameFauj } = require('../db/fauj');

// ─── Friend (Dost) Routes ───────────────────────────────────────────────────

// GET /api/social/friends — list my friends
router.get('/friends', async (req, res) => {
    try {
        const friends = await getFriends(req.userId);
        res.json({ friends });
    } catch (err) {
        console.error('Get friends error:', err.message);
        res.status(500).json({ error: 'Failed to fetch friends' });
    }
});

// GET /api/social/friends/requests — pending incoming requests
router.get('/friends/requests', async (req, res) => {
    try {
        const requests = await getPendingRequests(req.userId);
        res.json({ requests });
    } catch (err) {
        console.error('Get requests error:', err.message);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// POST /api/social/friends/request — send friend request
router.post('/friends/request', async (req, res) => {
    try {
        const { recipientId } = req.body;
        if (!recipientId) return res.status(400).json({ error: 'recipientId required' });
        if (recipientId === req.userId) return res.status(400).json({ error: 'Cannot friend yourself' });

        const friendship = await sendFriendRequest(req.userId, recipientId);
        res.json({ success: true, friendship });
    } catch (err) {
        console.error('Friend request error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/social/friends/:id/accept — accept a friend request
router.post('/friends/:id/accept', async (req, res) => {
    try {
        const friendship = await acceptFriendRequest(req.params.id, req.userId);
        res.json({ success: true, friendship });
    } catch (err) {
        console.error('Accept friend error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/social/friends/:id/decline — decline a friend request
router.post('/friends/:id/decline', async (req, res) => {
    try {
        await declineFriendRequest(req.params.id, req.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Decline friend error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/social/friends/:id — remove a friend
router.delete('/friends/:id', async (req, res) => {
    try {
        await removeFriend(req.params.id, req.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Remove friend error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ─── Fauj (Army) Routes ─────────────────────────────────────────────────────

// GET /api/social/fauj — list all faujs
router.get('/fauj', async (req, res) => {
    try {
        const faujs = await listFaujs();
        res.json({ faujs });
    } catch (err) {
        console.error('List faujs error:', err.message);
        res.status(500).json({ error: 'Failed to list faujs' });
    }
});

// GET /api/social/fauj/mine — my current fauj
router.get('/fauj/mine', async (req, res) => {
    try {
        const membership = await getUserFauj(req.userId);
        if (!membership) return res.json({ fauj: null });

        const fauj = await getFaujById(membership.fauj_id);
        res.json({ fauj, role: membership.role });
    } catch (err) {
        console.error('Get my fauj error:', err.message);
        res.status(500).json({ error: 'Failed to fetch fauj' });
    }
});

// GET /api/social/fauj/invites — my pending fauj invites
router.get('/fauj/invites', async (req, res) => {
    try {
        const invites = await getPendingInvites(req.userId);
        res.json({ invites });
    } catch (err) {
        console.error('Get invites error:', err.message);
        res.status(500).json({ error: 'Failed to fetch invites' });
    }
});

// POST /api/social/fauj — create a new fauj
router.post('/fauj', async (req, res) => {
    try {
        const { name, color } = req.body;
        if (!name) return res.status(400).json({ error: 'name required' });

        const fauj = await createFauj(req.userId, name, color);
        res.json({ success: true, fauj });
    } catch (err) {
        console.error('Create fauj error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// GET /api/social/fauj/:id — get fauj details
router.get('/fauj/:id', async (req, res) => {
    try {
        const fauj = await getFaujById(req.params.id);
        res.json({ fauj });
    } catch (err) {
        console.error('Get fauj error:', err.message);
        res.status(500).json({ error: 'Failed to fetch fauj' });
    }
});

// POST /api/social/fauj/:id/invite — invite a user to fauj
router.post('/fauj/:id/invite', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        const invite = await inviteToFauj(req.params.id, req.userId, userId);
        res.json({ success: true, invite });
    } catch (err) {
        console.error('Invite to fauj error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/social/fauj/invites/:id/respond — accept or decline invite
router.post('/fauj/invites/:id/respond', async (req, res) => {
    try {
        const { accept } = req.body;
        if (accept === undefined) return res.status(400).json({ error: 'accept (bool) required' });

        const result = await respondToInvite(req.params.id, req.userId, accept);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('Respond to invite error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/social/fauj/leave — leave current fauj
router.post('/fauj/leave', async (req, res) => {
    try {
        await leaveFauj(req.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Leave fauj error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/social/fauj/:id — disband fauj (leader only)
router.delete('/fauj/:id', async (req, res) => {
    try {
        await disbandFauj(req.params.id, req.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Disband fauj error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ─── Dwandva (Duel) Routes ──────────────────────────────────────────────────

// GET /api/social/duels — my active/pending duels
router.get('/duels', async (req, res) => {
    try {
        const duels = await getUserDuels(req.userId);
        res.json({ duels });
    } catch (err) {
        console.error('Get duels error:', err.message);
        res.status(500).json({ error: 'Failed to fetch duels' });
    }
});

// POST /api/social/duels/challenge — challenge a fauj mate
router.post('/duels/challenge', async (req, res) => {
    try {
        const { opponentId } = req.body;
        if (!opponentId) return res.status(400).json({ error: 'opponentId required' });
        if (opponentId === req.userId) return res.status(400).json({ error: 'Cannot duel yourself' });

        // Must be in the same fauj
        const myFauj = await getUserFauj(req.userId);
        if (!myFauj) return res.status(400).json({ error: 'You are not in a Fauj' });

        const same = await areInSameFauj(req.userId, opponentId);
        if (!same) return res.status(400).json({ error: 'You can only duel members of your own Fauj' });

        const duel = await createDuel(req.userId, opponentId, myFauj.fauj_id);
        res.json({ success: true, duel });
    } catch (err) {
        console.error('Create duel error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/social/duels/:id/accept — accept a duel challenge
router.post('/duels/:id/accept', async (req, res) => {
    try {
        const duel = await acceptDuel(req.params.id, req.userId);
        res.json({ success: true, duel });
    } catch (err) {
        console.error('Accept duel error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/social/duels/:id/cancel — cancel a duel
router.post('/duels/:id/cancel', async (req, res) => {
    try {
        const duel = await cancelDuel(req.params.id, req.userId);
        res.json({ success: true, duel });
    } catch (err) {
        console.error('Cancel duel error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
