const { resolveRecipientIdsForReferences } = require('./pushRecipients');
const { pushService } = require('./pushService');
const { emitNotificationToUserIds } = require('./socketNotifications');

const createNotificationDelivery = ({
    resolveRecipientIds = resolveRecipientIdsForReferences,
    emitRealtime = emitNotificationToUserIds,
    sendBrowserPush = (userIds, payload, options) => pushService.sendToUsers(userIds, payload, options),
    getIo = () => global.io,
    logger = console
} = {}) => {
    const deliverNotificationToReferences = async (
        references,
        payload,
        { eventId, excludeReferences = [] } = {}
    ) => {
        let recipientIds;
        try {
            recipientIds = await resolveRecipientIds(references, excludeReferences);
        } catch (error) {
            logger.error('Notification recipient resolution failed:', error.message);
            return { recipientIds: [], realtimeEmitted: 0, pushResults: [] };
        }

        const resolvedEventId = eventId || payload.eventId;
        const channelPayload = { ...payload, eventId: resolvedEventId };
        let realtimeEmitted = 0;
        try {
            realtimeEmitted = emitRealtime(getIo(), recipientIds, channelPayload);
        } catch (error) {
            logger.error('Realtime notification delivery failed:', error.message);
        }

        let pushResults = [];
        try {
            pushResults = await sendBrowserPush(recipientIds, channelPayload, { eventId: resolvedEventId });
        } catch (error) {
            logger.error('Browser push delivery failed:', error.message);
        }

        return { recipientIds, realtimeEmitted, pushResults };
    };

    return { deliverNotificationToReferences };
};

const { deliverNotificationToReferences } = createNotificationDelivery();

module.exports = { createNotificationDelivery, deliverNotificationToReferences };
