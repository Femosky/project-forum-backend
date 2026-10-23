import { User } from '@prisma/client';

class DateUtils {
    // Account age, not the user's age; there is no date of birth on User yet
    static isAccountOlderThan30Days(user: User) {
        const userAge = new Date(user.created_at).getTime();
        const now = new Date().getTime();
        const age = now - userAge; // in milliseconds
        return age >= 30 * 24 * 60 * 60 * 1000;
    }
}

export default DateUtils;
