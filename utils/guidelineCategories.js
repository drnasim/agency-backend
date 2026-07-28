const DEFAULT_GUIDELINE_CATEGORIES = Object.freeze([
    'Font',
    'Color',
    'Caption',
    'Highlight',
    'Background',
    'Transition',
    'Audio'
]);
const GUIDELINE_CATEGORY_CATALOG_VERSION = 2;

const normalizeGuidelineCategoryName = value => (
    String(value || '').trim().replace(/\s+/g, ' ')
);

const normalizeStoredGuidelineCategories = (values = []) => {
    const defaultNames = new Set(DEFAULT_GUIDELINE_CATEGORIES.map(name => name.toLowerCase()));
    const seen = new Set(defaultNames);
    const categories = [];

    for (const value of Array.isArray(values) ? values : []) {
        const name = normalizeGuidelineCategoryName(
            typeof value === 'string' ? value : value?.name
        );
        const key = name.toLowerCase();
        if (!name || name.length > 60 || seen.has(key)) continue;
        seen.add(key);
        categories.push(name);
    }

    return categories;
};

const normalizeFullGuidelineCategories = (values = []) => {
    const seen = new Set();
    const categories = [];

    for (const value of Array.isArray(values) ? values : []) {
        const name = normalizeGuidelineCategoryName(
            typeof value === 'string' ? value : value?.name
        );
        const key = name.toLowerCase();
        if (!name || name.length > 60 || seen.has(key)) continue;
        seen.add(key);
        categories.push(name);
    }

    return categories;
};

const isVersionedGuidelineCategoryCatalog = values => (
    Array.isArray(values) &&
    values.length === 1 &&
    Number(values[0]?.version) === GUIDELINE_CATEGORY_CATALOG_VERSION &&
    Array.isArray(values[0]?.categories)
);

const getGuidelineCategoryNames = (storedValues = []) => {
    if (isVersionedGuidelineCategoryCatalog(storedValues)) {
        return normalizeFullGuidelineCategories(storedValues[0].categories);
    }

    return [
        ...DEFAULT_GUIDELINE_CATEGORIES,
        ...normalizeStoredGuidelineCategories(storedValues)
    ];
};

const serializeGuidelineCategoryCatalog = categoryNames => ([{
    version: GUIDELINE_CATEGORY_CATALOG_VERSION,
    categories: normalizeFullGuidelineCategories(categoryNames)
}]);

const formatGuidelineCategoryCatalog = categoryNames => (
    normalizeFullGuidelineCategories(categoryNames)
        .map(name => ({ name, isDefault: false }))
);

const buildGuidelineCategoryCatalog = storedValues => (
    formatGuidelineCategoryCatalog(getGuidelineCategoryNames(storedValues))
);

const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const validateGuidelineCategoryName = (value) => {
    const name = normalizeGuidelineCategoryName(value);
    if (!name) throw createHttpError(400, 'Category name is required');
    if (name.length > 60) {
        throw createHttpError(400, 'Category name cannot exceed 60 characters');
    }
    return name;
};

const getGuidelineCategoryCatalog = async (settingsModel) => {
    const settings = await settingsModel
        .findOne({ type: 'guidelineCategories' })
        .lean();
    return buildGuidelineCategoryCatalog(settings?.payments);
};

const canonicalizeGuidelineItemCategories = (items, catalog) => {
    if (!Array.isArray(items)) return items;

    const canonicalNames = new Map(
        catalog.map(category => [
            normalizeGuidelineCategoryName(category.name).toLowerCase(),
            category.name
        ])
    );

    return items.map((item) => {
        const value = typeof item?.toObject === 'function'
            ? item.toObject()
            : item;
        const category = normalizeGuidelineCategoryName(value?.category);
        if (!category) return { ...value, category: '' };
        const canonicalName = canonicalNames.get(category.toLowerCase());
        if (!canonicalName) {
            throw createHttpError(
                400,
                `Unknown guideline category: ${category}`
            );
        }
        return { ...value, category: canonicalName };
    });
};

module.exports = {
    DEFAULT_GUIDELINE_CATEGORIES,
    GUIDELINE_CATEGORY_CATALOG_VERSION,
    buildGuidelineCategoryCatalog,
    canonicalizeGuidelineItemCategories,
    createHttpError,
    formatGuidelineCategoryCatalog,
    getGuidelineCategoryCatalog,
    getGuidelineCategoryNames,
    isVersionedGuidelineCategoryCatalog,
    normalizeFullGuidelineCategories,
    normalizeGuidelineCategoryName,
    normalizeStoredGuidelineCategories,
    serializeGuidelineCategoryCatalog,
    validateGuidelineCategoryName
};
