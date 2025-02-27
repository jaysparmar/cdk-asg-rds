import {
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_iam as iam,
    aws_lambda as lambda,
    aws_logs as logs, aws_route53,
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
import {
    ASSET_STACK_STRING,
    CLOUDFRONT_ORIGIN_SHIELD_REGION,
    LAMBDA_MEMORY,
    LAMBDA_TIMEOUT,
    MAX_IMAGE_SIZE,
    S3_TRANSFORMED_IMAGE_CACHE_TTL,
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION, STORE_TRANSFORMED_IMAGES
} from "./config/constants";
import {EnviornmentConfig} from "./models/enviornmentConfig";
import {getDomain, getEnviornmentConfig} from "./helper/functions";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import {app} from "../bin/ec2-lb-asg";




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

        const config: EnviornmentConfig | undefined = getEnviornmentConfig(id.split(ASSET_STACK_STRING)[0]);



        if (config === undefined) {
            throw new Error('Invalid stackId');
        }




        const originalImageBucket = new s3.Bucket(this, id + "original-bucket", {
            removalPolicy: RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            autoDeleteObjects: true,
        });
        new s3deploy.BucketDeployment(this, id + '-DeployWebsite', {
            sources: [s3deploy.Source.asset('./image-sample')],
            destinationBucket: originalImageBucket,
            destinationKeyPrefix: '/',
        });
        new CfnOutput(this, id + '-OriginalAssetsS3Bucket', {
            description: 'S3 bucket where original images are stored',
            value: originalImageBucket.bucketName
        });


        const transformedImageBucket = new s3.Bucket(this, id + "transformed-bucket", {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
                },
            ],
        });


        // prepare env variable for Lambda
        const lambdaEnv: LambdaEnv = {
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
        const iamPolicyStatements = [s3ReadOriginalImagesPolicy];

        // Create Lambda for image processing
        let lambdaProps = {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset('functions/image-processing'),
            timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
            memorySize: parseInt(LAMBDA_MEMORY),
            environment: lambdaEnv,
            logRetention: logs.RetentionDays.ONE_DAY,

        };

        const imageProcessing = new lambda.Function(this, id + ('image-optimization'), lambdaProps);


        // Enable Lambda URL
        const imageProcessingURL = imageProcessing.addFunctionUrl();

        // Leverage CDK Intrinsics to get the hostname of the Lambda URL
        const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

        // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
        let imageOrigin;
        let defaultOrigin;

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
            const s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
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
            new iam.Policy(this, id + ('-read-write-bucket-policy'), {
                statements: iamPolicyStatements,
            }),
        );

        // Create a CloudFront Function for url rewrites
        const urlRewriteFunction = new cloudfront.Function(this, id + ('-urlRewrite'), {
            code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js',}),
            functionName: `${id}-urlRewriteFunction`,
        });

        let imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
            origin: imageOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            compress: false,
            cachePolicy: new cloudfront.CachePolicy(this, `${id}-ImageCachePolicy`, {
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
        let defaultCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
            origin: defaultOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            compress: false,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            functionAssociations: undefined,
        }


            // Creating a custom response headers policy. CORS allowed for all origins.
            imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${id}`, {
                responseHeadersPolicyName: `ImageResponsePolicy${id}`,
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

        const stack1 = new Stack(app, id + '-ssl-dns', {
            env: {
                account: process.env.CDK_DEFAULT_ACCOUNT, // Replace with your AWS account ID if not using default
                region: 'us-east-1', // Replace with your desired region
            },
            crossRegionReferences: true,
        });

        const myHostedZone = aws_route53.HostedZone.fromLookup(stack1, 'HostedZone', {
            domainName: config.hostedZoneDomain, // Replace with your domain name
        });
        const cdnCert = new acm.Certificate(stack1, 'cdn-Cert', {
            domainName: getDomain(config, config.cdnDomain),
            validation: acm.CertificateValidation.fromDns(myHostedZone),
        });



        const imageDelivery = new cloudfront.Distribution(this, id + ('-imageDeliveryDistribution'), {
            comment: `${id} Asset CDN`,
            defaultBehavior: defaultCacheBehaviorConfig,
            additionalBehaviors: {
                '/*.png': imageDeliveryCacheBehaviorConfig,
                '/*.jpg': imageDeliveryCacheBehaviorConfig,
                '/*.jpeg': imageDeliveryCacheBehaviorConfig,
            },
            domainNames: [getDomain(config, config.cdnDomain)], // Replace with your domain name
            certificate: cdnCert
        });


        // ADD OAC between CloudFront and LambdaURL
        const oac = new cloudfront.CfnOriginAccessControl(this, id + ("OAC"), {
            originAccessControlConfig: {
                name: `oac${id}`,
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
            description: `${id} Asset CDN `,
            value: imageDelivery.distributionDomainName
        });
    }
}