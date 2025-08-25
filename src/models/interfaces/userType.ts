export enum UserStatus {
    ACTIVE = 'ACTIVE',
    SUSPENDED = 'SUSPENDED',
    BANNED = 'BANNED',
    DELETED = 'DELETED',
}

export enum UserType {
    REGULAR = 'REGULAR',
    BUSINESS = 'BUSINESS',
}

export interface UserInterface {
    id: string;
    created_at: Date;
    updated_at: Date;
    last_login: Date | null;
    username: string;
    email: string;
    password_hash: string;
    avatar_id: string;
    account_status: UserStatus;
    user_type: UserType;
    is_email_verified: boolean;
    notification_preferences: Object | null;
}
