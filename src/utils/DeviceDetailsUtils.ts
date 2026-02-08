// import { UAParser } from 'ua-parser-js';
import maxmind from 'maxmind';

export interface LoginSessionDetails {
    userAgent: string | null;
    browser: string | null | undefined;
    os: string | null | undefined;
    device: string | null | undefined;
    ipAddress: string | null | undefined;
    error?: unknown;
}

export class DeviceDetailsUtils {
    static async getUserIPInformation(request: any) {
        try {
            const ip = request.socket.remoteAddress;
            // const lookup = await maxmind.open('./dependencies/GeoLite2-ASN.mmdb');
            console.log(ip);
            // const result = lookup.get(ip);

            // if (!result) {
            //     return { country: null, asn: null, error: 'IP not found' };
            // }

            // console.log(result);

            return { ip };
        } catch (error) {
            return { error: 'sj' };
        }
    }
}
