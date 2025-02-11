import {
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_iam as iam,
    aws_lambda as lambda,
    aws_logs as logs,
    aws_s3 as s3,
    aws_s3_deployment as s3deploy,
    CfnOutput,
    Duration,
    Fn,
    RemovalPolicy,
    Stack,
    StackProps
} from 'aws-cdk-lib';
import {CacheHeaderBehavior, CfnDistribution} from "aws-cdk-lib/aws-cloudfront";
import {Construct} from 'constructs';
import {getOriginShieldRegion} from './origin-shield';
import {config} from "./config";


// Implement the toPascalCase method on the Array prototype
let toPascalCase = function (words: string[]): string {
    /**
     * Converts an array of words to PascalCase.
     *
     * @returns A single string converted to PascalCase.
     */
    if (words.length === 0) {
        return "";
    }

    return words.map((word: string) =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join("");
};





const generateResourceString = ( resource: string, includeStackId:boolean = true): string =>  `${config.env}-${resource}`+(includeStackId ?`-${config.stackId}`:"");


var STORE_TRANSFORMED_IMAGES = 'true';

var S3_IMAGE_BUCKET_NAME: string;

var CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');

var CLOUDFRONT_CORS_ENABLED = 'true';

var S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';

var S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';

var MAX_IMAGE_SIZE = '4700000';

// Lambda Parameters
var LAMBDA_MEMORY = '1500';

var LAMBDA_TIMEOUT = '60';

var CREATE_NEW_BUCKET:  boolean = false;

var DEPLOY_SAMPLE_WEBSITE = 'false';

type ImageDeliveryCacheBehaviorConfig = {
    origin: any;
    compress: any;
    viewerProtocolPolicy: any;
    cachePolicy: any;
    functionAssociations: any;
    responseHeadersPolicy?: any;
};

type LambdaEnv = {
    originalImageBucketName: string,
    transformedImageBucketName?: string;
    transformedImageCacheTTL: string,
    maxImageSize: string,
}



export class ImageOptimizationStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        let appendStackEnv = toPascalCase([config.env, config.stackId])




        // Change stack parameters based on provided context
        STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
        S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
        S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
        S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
        CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
        CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
        LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
        LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
        MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;
        DEPLOY_SAMPLE_WEBSITE = this.node.tryGetContext('DEPLOY_SAMPLE_WEBSITE') || DEPLOY_SAMPLE_WEBSITE;


        // deploy a sample website for testing if required
        if (DEPLOY_SAMPLE_WEBSITE === 'true') {
            var sampleWebsiteBucket = new s3.Bucket(this, 's3-sample-website-bucket', {
                removalPolicy: RemovalPolicy.DESTROY,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                autoDeleteObjects: true,
            });

            var sampleWebsiteDelivery = new cloudfront.Distribution(this, 'websiteDeliveryDistribution', {
                comment: 'image optimization - sample website',
                defaultRootObject: 'index.html',
                defaultBehavior: {
                    origin: new origins.S3Origin(sampleWebsiteBucket),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                }
            });

            new CfnOutput(this, 'SampleWebsiteDomain', {
                description: 'Sample website domain',
                value: sampleWebsiteDelivery.distributionDomainName
            });
            new CfnOutput(this, 'SampleWebsiteS3Bucket', {
                description: 'S3 bucket use by the sample website',
                value: sampleWebsiteBucket.bucketName
            });
        }


        // For the bucket having original images, either use an external one, or create one with some samples photos.
        var originalImageBucket;
        var transformedImageBucket;



        CREATE_NEW_BUCKET = config.createNewBucket;

        if (!CREATE_NEW_BUCKET) {
            originalImageBucket = s3.Bucket.fromBucketName(this, generateResourceString('imported-original-image-bucket'), S3_IMAGE_BUCKET_NAME);
            new CfnOutput(this, generateResourceString('OriginalImagesS3Bucket'), {
                description: 'S3 bucket where original images are stored',
                value: originalImageBucket.bucketName
            });
        } else {

            originalImageBucket = new s3.Bucket(this, generateResourceString(config.newBucketName), {
                removalPolicy: RemovalPolicy.DESTROY,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                autoDeleteObjects: true,
            });
            new s3deploy.BucketDeployment(this, appendStackEnv + ('DeployWebsite'), {
                sources: [s3deploy.Source.asset('./image-sample')],
                destinationBucket: originalImageBucket,
                destinationKeyPrefix: '/',
            });
            new CfnOutput(this, appendStackEnv +('OriginalAssetsS3Bucket'), {
                description: 'S3 bucket where original images are stored',
                value: originalImageBucket.bucketName
            });
        }

        // create bucket for transformed images if enabled in the architecture
        if (STORE_TRANSFORMED_IMAGES === 'true') {
            transformedImageBucket = new s3.Bucket(this, generateResourceString(`cache-${config.newBucketName}`), {
                removalPolicy: RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                lifecycleRules: [
                    {
                        expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
                    },
                ],
            });
        }

        // prepare env variable for Lambda
        var lambdaEnv: LambdaEnv = {
            originalImageBucketName: originalImageBucket.bucketName,
            transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,

            maxImageSize: MAX_IMAGE_SIZE,
        };
        if (transformedImageBucket) lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;

        // IAM policy to read from the S3 bucket containing the original images
        const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
        });

        // statements of the IAM policy to attach to Lambda
        var iamPolicyStatements = [s3ReadOriginalImagesPolicy];

        // Create Lambda for image processing
        var lambdaProps = {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset('functions/image-processing'),
            timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
            memorySize: parseInt(LAMBDA_MEMORY),
            environment: lambdaEnv,
            logRetention: logs.RetentionDays.ONE_DAY,

        };

        var imageProcessing = new lambda.Function(this, generateResourceString('image-optimization'), lambdaProps);


        // Enable Lambda URL
        const imageProcessingURL = imageProcessing.addFunctionUrl();

        // Leverage CDK Intrinsics to get the hostname of the Lambda URL
        const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

        // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
        var imageOrigin;
        var defaultOrigin;

        if (transformedImageBucket) {
            imageOrigin = new origins.OriginGroup({
                primaryOrigin: new origins.S3Origin(transformedImageBucket, {
                    originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
                }),
                fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
                    originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
                }),
                fallbackStatusCodes: [403, 500, 503, 504],
            });
            defaultOrigin = new origins.S3Origin(originalImageBucket, {
                originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
            })

            // write policy for Lambda on the s3 bucket for transformed images
            var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
                actions: ['s3:PutObject'],
                resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
            });
            iamPolicyStatements.push(s3WriteTransformedImagesPolicy);
        } else {
            imageOrigin = new origins.HttpOrigin(imageProcessingDomainName, {
                originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
            });
        }

        // attach iam policy to the role assumed by Lambda
        imageProcessing.role?.attachInlinePolicy(
            new iam.Policy(this, generateResourceString('read-write-bucket-policy'), {
                statements: iamPolicyStatements,
            }),
        );

        // Create a CloudFront Function for url rewrites
        const urlRewriteFunction = new cloudfront.Function(this, generateResourceString('urlRewrite'), {
            code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js',}),
            functionName: `urlRewriteFunction${appendStackEnv}`,
        });

        var imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
            origin: imageOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            compress: false,
            cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy${appendStackEnv}`, {
                defaultTtl: Duration.hours(24),
                maxTtl: Duration.days(365),
                minTtl: Duration.seconds(0),
                headerBehavior: CacheHeaderBehavior.allowList("x-meta-cloudfront-url")
            }),
            functionAssociations: [{
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                function: urlRewriteFunction,
            }],

        }
        var defaultCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
            origin: defaultOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            compress: false,
            cachePolicy:cloudfront.CachePolicy.CACHING_OPTIMIZED,
            functionAssociations: undefined,

        }



        if (CLOUDFRONT_CORS_ENABLED === 'true') {
            // Creating a custom response headers policy. CORS allowed for all origins.
            imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${appendStackEnv}`, {
                responseHeadersPolicyName: `ImageResponsePolicy${appendStackEnv}`,
                corsBehavior: {
                    accessControlAllowCredentials: false,
                    accessControlAllowHeaders: ['*'],
                    accessControlAllowMethods: ['GET'],
                    accessControlAllowOrigins: ['*'],
                    accessControlMaxAge: Duration.seconds(600),
                    originOverride: false,
                },
                // recognizing image requests that were processed by this solution
                customHeadersBehavior: {
                    customHeaders: [
                        {header: 'x-aws-image-optimization', value: 'v1.0', override: true},
                        {header: 'vary', value: 'accept', override: true},
                    ],
                }
            });


        }


        const imageDelivery = new cloudfront.Distribution(this, generateResourceString('imageDeliveryDistribution'), {
            comment: `${config.env} Asset CDN ${config.stackId}`,
            defaultBehavior: defaultCacheBehaviorConfig,
            additionalBehaviors: {
                '/*.png': imageDeliveryCacheBehaviorConfig,
                '/*.jpg': imageDeliveryCacheBehaviorConfig,
                '/*.jpeg': imageDeliveryCacheBehaviorConfig,
            }
        });




        // ADD OAC between CloudFront and LambdaURL
        const oac = new cloudfront.CfnOriginAccessControl(this, generateResourceString("OAC"), {
            originAccessControlConfig: {
                name: `oac${appendStackEnv}`,
                originAccessControlOriginType: "lambda",
                signingBehavior: "always",
                signingProtocol: "sigv4",
            },
        });

        const cfnImageDelivery = imageDelivery.node.defaultChild as CfnDistribution;

        // cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${(STORE_TRANSFORMED_IMAGES === 'true') ? "0" : "0"}.OriginAccessControlId`, s3Oac.getAtt("Id"));
        cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${(STORE_TRANSFORMED_IMAGES === 'true') ? "2" : "2"}.OriginAccessControlId`, oac.getAtt("Id"));

        imageProcessing.addPermission("AllowCloudFrontServicePrincipal", {
            principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
            action: "lambda:InvokeFunctionUrl",
            sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${imageDelivery.distributionId}`
        })


        new CfnOutput(this, 'ImageDeliveryDomain', {
            description: `${config.env} Asset CDN ${config.stackId}`,
            value: imageDelivery.distributionDomainName
        });
    }
}