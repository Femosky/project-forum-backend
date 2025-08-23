enum UserStatus {
    ACTIVE = 'ACTIVE',
    SUSPENDED = 'SUSPENDED',
    BANNED = 'BANNED',
    DELETED = 'DELETED',
}

enum UserType {
    REGULAR = 'REGULAR',
    BUSINESS = 'BUSINESS',
}

export interface User {
    id: string;
    created_at: Date;
    updated_at: Date;
    last_login: Date | null;
    username: string;
    email: string;
    password_hash: string;
    profile_picture_url: string | null;
    account_status: UserStatus;
    user_type: UserType;
    is_email_verified: boolean;
    notification_preferences: Object | null;
}
