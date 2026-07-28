const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const normalizeGuidelineItemsForWrite = (items) => {
    if (!Array.isArray(items)) return items;

    return items.map((item) => {
        const normalized = { ...item };
        const referenceUrl = String(normalized.referenceUrl || '').trim();

        normalized.category = String(normalized.category || '').trim();
        normalized.instruction = String(normalized.instruction || '').trim();
        normalized.referenceName = String(normalized.referenceName || '').trim();
        normalized.referenceUrl = referenceUrl;
        if (!referenceUrl) {
            normalized.referenceType = '';
            normalized.referenceName = '';
        } else if (!normalized.referenceType) {
            normalized.referenceType = 'link';
        }

        return normalized;
    });
};

const toPlainGuidelineItem = (item) => {
    const value = typeof item?.toObject === 'function'
        ? item.toObject()
        : { ...item };

    return {
        ...(value._id ? { _id: value._id } : {}),
        category: String(value.category || '').trim(),
        instruction: String(value.instruction || '').trim(),
        ruleType: ['Must Use', 'Prefer', 'Avoid'].includes(value.ruleType)
            ? value.ruleType
            : 'Prefer',
        referenceType: ['', 'link', 'image'].includes(value.referenceType)
            ? value.referenceType
            : '',
        referenceUrl: String(value.referenceUrl || '').trim(),
        referenceName: String(value.referenceName || '').trim()
    };
};

const prioritizeMustUseGuidelines = (items = []) => (
    items
        .map((item, index) => ({ item: toPlainGuidelineItem(item), index }))
        .sort((left, right) => {
            const priorities = { 'Must Use': 0, Prefer: 1, Avoid: 2 };
            const leftPriority = priorities[left.item.ruleType];
            const rightPriority = priorities[right.item.ruleType];
            return leftPriority - rightPriority || left.index - right.index;
        })
        .map(entry => entry.item)
);

const buildLegacyGuidelines = (items = [], additionalNotes = '') => {
    const itemBlocks = prioritizeMustUseGuidelines(Array.isArray(items) ? items : [])
        .map((item) => {
            const categoryLabel = item.category || 'Uncategorized';
            const lines = [`[${item.ruleType}] ${categoryLabel}: ${item.instruction}`];

            if (item.referenceUrl) {
                const referenceLabel = item.referenceName
                    ? `Reference (${item.referenceName})`
                    : 'Reference';
                lines.push(`${referenceLabel}: ${item.referenceUrl}`);
            }

            return lines.join('\n');
        });

    const notes = String(additionalNotes || '').trim();
    if (notes) itemBlocks.push(`Additional Notes:\n${notes}`);
    return itemBlocks.join('\n\n');
};

const hasStructuredGuidelineFields = body => (
    hasOwn(body, 'guidelineItems') || hasOwn(body, 'guidelineNotes')
);

const hasStructuredGuidelineData = client => (
    Array.from(client?.guidelineItems || []).length > 0 ||
    Boolean(String(client?.guidelineNotes || '').trim())
);

const buildClientWritePayload = (body = {}, existingClient = null) => {
    const payload = { ...body };
    if (
        !hasStructuredGuidelineFields(body) &&
        !hasStructuredGuidelineData(existingClient)
    ) {
        return payload;
    }

    if (hasOwn(body, 'guidelineNotes')) {
        payload.guidelineNotes = String(body.guidelineNotes || '').trim();
    }
    if (hasOwn(body, 'guidelineItems')) {
        payload.guidelineItems = normalizeGuidelineItemsForWrite(body.guidelineItems);
    }

    const items = hasOwn(body, 'guidelineItems')
        ? payload.guidelineItems
        : existingClient?.guidelineItems || [];
    let additionalNotes = hasOwn(body, 'guidelineNotes')
        ? payload.guidelineNotes
        : existingClient?.guidelineNotes || '';

    if (
        !hasOwn(body, 'guidelineNotes') &&
        !String(additionalNotes || '').trim() &&
        !Array.from(existingClient?.guidelineItems || []).length &&
        typeof existingClient?.guidelines === 'string'
    ) {
        additionalNotes = existingClient.guidelines;
        payload.guidelineNotes = existingClient.guidelines;
    }

    payload.guidelines = buildLegacyGuidelines(items, additionalNotes);
    return payload;
};

const buildClientGuidelineData = (client) => {
    if (!client) {
        return {
            clientGuidelines: '',
            clientGuidelineProfile: { items: [], additionalNotes: '' }
        };
    }

    const items = Array.isArray(client.guidelineItems)
        ? prioritizeMustUseGuidelines(client.guidelineItems)
        : [];
    const structuredNotes = String(client.guidelineNotes || '').trim();
    const legacyText = typeof client.guidelines === 'string'
        ? client.guidelines
        : '';
    const hasStructuredData = items.length > 0 || Boolean(structuredNotes);
    const additionalNotes = structuredNotes || (
        items.length === 0 && legacyText.trim() ? legacyText : ''
    );
    const generatedText = buildLegacyGuidelines(items, structuredNotes);

    return {
        clientGuidelines: hasStructuredData
            ? generatedText
            : legacyText,
        clientGuidelineProfile: {
            items,
            additionalNotes
        }
    };
};

module.exports = {
    buildClientGuidelineData,
    buildClientWritePayload,
    buildLegacyGuidelines,
    hasStructuredGuidelineData,
    hasStructuredGuidelineFields,
    normalizeGuidelineItemsForWrite,
    prioritizeMustUseGuidelines,
    toPlainGuidelineItem
};
