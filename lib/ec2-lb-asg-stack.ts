import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import {aws_route53, Stack} from "aws-cdk-lib";
import {app} from "../bin/ec2-lb-asg";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import {getDomain, getEnviornmentConfig} from "./helper/functions";
import {EnviornmentConfig} from "./models/enviornmentConfig";


export class Ec2LbAsgStack extends cdk.Stack {
    constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const githubToken: string | undefined = process.env.GITHUB_TOKEN;
        const config: EnviornmentConfig | undefined = getEnviornmentConfig(id);
        if (config === undefined) {
            throw new Error('Invalid stackId');
        }


        // Step 1: Create a VPC
        const vpc = new ec2.Vpc(this, 'VPC', {
            maxAzs: 2,
        });

        // Step 2: Security Groups
        const instanceSG = new ec2.SecurityGroup(this, 'InstanceSG', {
            vpc,
            description: 'Allow HTTP, HTTPS, and SSH',
            allowAllOutbound: true,
        });
        instanceSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH Access');
        instanceSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP Access');

        const rdsSG = new ec2.SecurityGroup(this, 'RdsSG', {
            vpc,
            description: 'Allow MySQL Access',
            allowAllOutbound: true,
        });
        rdsSG.addIngressRule(instanceSG, ec2.Port.tcp(3306), 'MySQL Access from EC2');

        // Step 3: Create RDS Instance
        const database = new rds.DatabaseInstance(this, 'RDSInstance', {
            engine: rds.DatabaseInstanceEngine.mysql({
                version: rds.MysqlEngineVersion.VER_8_0_34,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
            credentials: rds.Credentials.fromGeneratedSecret('admin'),
            databaseName: config.databaseName,
            vpc,
            securityGroups: [rdsSG],
            allocatedStorage: 20,
            publiclyAccessible: config.databasePubliclyAccessible,
        });

        // Step 4: User Data Script
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'sudo su',
            'apt-get update -y',
            'apt-get install -y software-properties-common',
            'add-apt-repository ppa:ondrej/php -y',
            'apt-get update -y',
            'apt-get install -y php8.0 php8.0-mysql php8.0-curl apache2 git jq unzip',
            'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"',
            'unzip awscliv2.zip',
            './aws/install',
            'systemctl start apache2',
            'systemctl enable apache2',
            'rm -rf /var/www/html',
            'git clone https://' + githubToken + '@github.com/ZinZuu-Dev/zinzuu-web.git /var/www/html || (cd /var/www/html && git pull && git checkout '+config.branchName+')',
            'chown -R www-data:www-data /var/www/html',
            'systemctl restart apache2',
            'touch /var/www/html/.env',
            'git config --global --add safe.directory /var/www/html',
            "sudo a2enmod rewrite",
            "systemctl restart apache2",
            'echo "<Directory /var/www/html>" > /etc/apache2/conf-available/allow-htaccess.conf',
            'echo "    AllowOverride All" >> /etc/apache2/conf-available/allow-htaccess.conf',
            'echo "</Directory>" >> /etc/apache2/conf-available/allow-htaccess.conf',
            'a2enconf allow-htaccess',
            'systemctl reload apache2',
            `echo "DB_HOST=${database.dbInstanceEndpointAddress}" >> /var/www/html/.env`,
            `echo "DB_USERNAME=admin" >> /var/www/html/.env`,
            `DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id '${database.secret?.secretArn}' --query SecretString --output text | jq -r .password)`,
            `if [ -z "$DB_PASSWORD" ]; then echo "Error: DB_PASSWORD is empty"; exit 1; fi`,
            `echo "DB_PASSWORD=$DB_PASSWORD" >> /var/www/html/.env`,
            `echo "DB_DATABASE=${config.databaseName}" >> /var/www/html/.env`
        );

        // Step 5: Create Auto Scaling Group
        const ec2Role = new iam.Role(this, 'InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // Add the policy to allow access to the secret
        const secretPolicy = new iam.Policy(this, 'SecretAccessPolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [database.secret?.secretArn || ''],
                }),
            ],
        });

        ec2Role.attachInlinePolicy(secretPolicy);

        const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
            vpc,
            instanceType: ec2.InstanceType.of(config.ec2InstanceType, config.ec2InstanceSize),
            machineImage: new ec2.GenericLinuxImage({
                [config.amiRegion]: config.amiId,
            }),
            role: ec2Role,
            securityGroup: instanceSG,
            userData,
            minCapacity: config.asgMinCapacity,
            maxCapacity: config.asgMaxCapacity,
            keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPair', config.keyPairName),
            associatePublicIpAddress: config.associatePublicIpAddress,
        });




        // Step 6: Create Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            vpc,
            internetFacing: true,
        });

        const listener = alb.addListener('Listener', {
            port: 80,
            open: true,
        });

        listener.addTargets('Target', {
            port: 80,
            targets: [asg],
            healthCheck: {
                path: '/', // Adjust this path if your application serves health checks at a different endpoint
                interval: cdk.Duration.seconds(30), // Adjust interval as needed
            },
        });


        const stack1 = new Stack(app, id + '-compute-ssl', {
            env: {
                account: process.env.CDK_DEFAULT_ACCOUNT, // Replace with your AWS account ID if not using default
                region: 'us-east-1', // Replace with your desired region
            },
            crossRegionReferences: true,
        });

        const myHostedZone = aws_route53.HostedZone.fromLookup(stack1, 'HostedZone', {
            domainName: config.hostedZoneDomain, // Replace with your domain name
        });

        // Generate Certificates

        // main site
        const mainCert = new acm.Certificate(stack1, 'main-Cert', {
            domainName: getDomain(config, config.mainDomain),
            validation: acm.CertificateValidation.fromDns(myHostedZone),

        });
        // api
        const apiCert = new acm.Certificate(stack1, 'api-Cert', {
            domainName: getDomain(config, config.apiDomain),
            validation: acm.CertificateValidation.fromDns(myHostedZone),
        });
        // merchant
        const merchantCert = new acm.Certificate(stack1, 'merchant-Cert', {
            domainName: getDomain(config, config.merchantDomain),
            validation: acm.CertificateValidation.fromDns(myHostedZone),
        });

        const adminCert = new acm.Certificate(stack1, 'admin-Cert', {
            domainName: getDomain(config, config.adminDomain),
            validation: acm.CertificateValidation.fromDns(myHostedZone),
        });

        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: id + ' CloudFront Distribution for main site',
            defaultBehavior: {
                origin: new origins.LoadBalancerV2Origin(alb, {
                    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Disable caching for API requests
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER, // Forward all headers
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, // Allow all HTTP methods
            },
            additionalBehaviors: {
                '*.css': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                '*.js': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
            },
            domainNames: [getDomain(config, config.mainDomain)], // Replace with your domain name
            certificate: mainCert
        });


        const apiDistribution = new cloudfront.Distribution(this, 'API-Distribution', {
            comment: id + ' CloudFront Distribution for api',
            defaultBehavior: {
                origin: new origins.LoadBalancerV2Origin(alb, {
                    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Disable caching for API requests
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER, // Forward all headers
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, // Allow all HTTP methods
            },
            additionalBehaviors: {
                '*.css': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                '*.js': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
            },
            domainNames: [getDomain(config, config.apiDomain)], // Replace with your domain name
            certificate: apiCert
        });


        const merchantDistribution = new cloudfront.Distribution(this, 'merchant-Distribution', {
            comment: id + ' CloudFront Distribution for merchant',
            defaultBehavior: {
                origin: new origins.LoadBalancerV2Origin(alb, {
                    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Disable caching for API requests
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER, // Forward all headers
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, // Allow all HTTP methods
            },
            additionalBehaviors: {
                '*.css': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                '*.js': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
            },
            domainNames: [getDomain(config, config.merchantDomain)], // Replace with your domain name
            certificate: merchantCert
        });


        const adminViewerRequestFunction = new cloudfront.Function(this, id + ('-viewer-request'), {
            code: cloudfront.FunctionCode.fromFile({filePath: 'functions/compute-viewer-request/admin.js',}),
            functionName: `${id}-urlRewriteFunction`,
        });
        const adminDistribution = new cloudfront.Distribution(this, 'admin-Distribution', {
            comment: id + ' CloudFront Distribution for admin',
            defaultBehavior: {
                origin: new origins.LoadBalancerV2Origin(alb, {
                    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Disable caching for API requests
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER, // Forward all headers
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, // Allow all HTTP methods
                functionAssociations: [{
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    function: adminViewerRequestFunction,
                }],
            },
            additionalBehaviors: {
                '*.css': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                '*.js': {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
            },

            domainNames: [getDomain(config, config.adminDomain)], // Replace with your domain name
            certificate: adminCert
        });

        // Create a CNAME record
        new aws_route53.CnameRecord(this, 'CnameRecord-main', {
            zone: myHostedZone,
            recordName: config.mainDomain,
            domainName: distribution.distributionDomainName,
            deleteExisting: true,
        });
        new aws_route53.CnameRecord(this, 'CnameRecord-api', {
            zone: myHostedZone,
            recordName: config.apiDomain,
            domainName: apiDistribution.distributionDomainName,
            deleteExisting: true,
        });
        new aws_route53.CnameRecord(this, 'CnameRecord-merchant', {
            zone: myHostedZone,
            recordName: config.merchantDomain,
            domainName: merchantDistribution.distributionDomainName,
            deleteExisting: true,
        });
        new aws_route53.CnameRecord(this, 'CnameRecord-admin', {
            zone: myHostedZone,
            recordName: config.adminDomain,
            domainName: adminDistribution.distributionDomainName,
            deleteExisting: true,
        });
        // Outputs
        new cdk.CfnOutput(this, 'CloudFrontURL', {value: distribution.distributionDomainName});

        // Output
        new cdk.CfnOutput(this, 'ALBDNS', {value: alb.loadBalancerDnsName});
        new cdk.CfnOutput(this, 'DBEndpoint', {value: database.dbInstanceEndpointAddress});
    }
}
