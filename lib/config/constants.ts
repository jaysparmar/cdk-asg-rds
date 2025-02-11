import {getOriginShieldRegion} from "../origin-shield";

export const STORE_TRANSFORMED_IMAGES = 'true';

export const CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');

export const S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';

export const S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';

export const MAX_IMAGE_SIZE = '4700000';

// Lambda Parameters
export const LAMBDA_MEMORY = '1500';

export const LAMBDA_TIMEOUT = '60';

export const ASSET_STACK_STRING = '-asset';


