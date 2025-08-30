import { User } from '@prisma/client';

class DateUtils {
    static isAgeGreaterThan18Years(user: User) {
        const userAge = new Date(user.created_at).getTime();
        const now = new Date().getTime();
        const age = now - userAge; // in milliseconds
        return age >= 18 * 365 * 24 * 60 * 60 * 1000;
    }

    static isAgeGreaterThan30Days(user: User) {
        const userAge = new Date(user.created_at).getTime();
        const now = new Date().getTime();
        const age = now - userAge; // in milliseconds
        return age >= 30 * 24 * 60 * 60 * 1000;
    }
}

export default DateUtils;
