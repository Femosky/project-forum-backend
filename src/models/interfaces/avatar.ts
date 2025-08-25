export const AVATAR_OPTIONS = {
    default_1: {
        id: 'default_1',
        name: 'Default Avatar 1',
        description: 'Default Avatar 1',
        image_url: 'https://via.placeholder.com/150',
    },
    default_2: {
        id: 'default_2',
        name: 'Default Avatar 2',
        description: 'Default Avatar 2',
        image_url: 'https://via.placeholder.com/150',
    },
    default_3: {
        id: 'default_3',
        name: 'Default Avatar 3',
        description: 'Default Avatar 3',
        image_url: 'https://via.placeholder.com/150',
    },
} as const;

export type AvatarId = keyof typeof AVATAR_OPTIONS;
