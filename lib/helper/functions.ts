import {environments} from "../config/enviornments";
import {EnviornmentConfig} from "../models/enviornmentConfig";

export function getEnviornmentConfig(stackId: string): EnviornmentConfig | undefined {
    return environments.find(env => env.stackId === stackId);
}


export function getDomain(config: EnviornmentConfig, subDomain: string): string {
    if(subDomain == ""){
        return `${config.hostedZoneDomain}`;
    }
    return `${subDomain}.${config.hostedZoneDomain}`;
}