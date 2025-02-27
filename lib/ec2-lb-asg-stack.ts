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

        const commands = [
            // 'sudo su',
            'sudo apt-get update -y',
            'sudo apt-get install -y software-properties-common',
            'sudo add-apt-repository ppa:ondrej/php -y',
            'sudo apt-get update -y',
            'sudo apt-get install -y php8.2 php8.2-mysql php8.2-gd php8.2-sqlite3 php8.2-zip php8.2-imap php8.2-mbstring php8.2-mailparse php8.2-curl php8.2-simplexml php8.2-dom apache2 git jq unzip',
            'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"',
            'unzip awscliv2.zip',
            'sudo ./aws/install',
            'sudo systemctl start apache2',
            'sudo systemctl enable apache2',
            'sudo rm -rf /var/www/html/index.html',

            'sudo git clone https://' + githubToken + '@github.com/ZinZuu-Dev/zinzuu-central.git /var/www/html || (cd /var/www/html && git pull && git checkout '+config.branchName+')',

            'sudo systemctl restart apache2',
            'sudo touch /var/www/html/.env',
            'sudo git config --global --add safe.directory /var/www/html',
            'sudo a2enmod rewrite',
            'sudo systemctl restart apache2',
            'sudo su',
            'echo "<Directory /var/www/html>" > /etc/apache2/conf-available/allow-htaccess.conf',
            'echo "    AllowOverride All" >> /etc/apache2/conf-available/allow-htaccess.conf',
            'echo "</Directory>" >> /etc/apache2/conf-available/allow-htaccess.conf',
            'a2enconf allow-htaccess',
            'systemctl reload apache2',
            `echo "APP_NAME='Zinzuu'" >> /var/www/html/.env`,
            `echo "APP_ENV=production" >> /var/www/html/.env`,
            `echo "APP_LOCALE=en" >> /var/www/html/.env`,
            `echo "APP_TIMEZONE='America/Los_Angeles'" >> /var/www/html/.env`,
            `echo "APP_KEY=base64:R2Zf4aNfrhJ8zIPm7S1r5mf9yvU6XkhLb0FoVzQ/qJY=" >> /var/www/html/.env`,
            `echo "APP_DEBUG=true" >> /var/www/html/.env`,
            `echo "APP_DEMO=false" >> /var/www/html/.env`,
            `echo "APP_URL=https://${getDomain(config, config.mainDomain)}" >> /var/www/html/.env`,
            `echo "APP_BRAND=false" >> /var/www/html/.env`,
            `echo "APP_SAAS=true" >> /var/www/html/.env`,
            `echo "APP_DEFAULT_LOGO_LIGHT='images/logo_light.svg'" >> /var/www/html/.env`,
            `echo "APP_DEFAULT_LOGO_DARK='images/logo_dark.svg'" >> /var/www/html/.env`,
            `echo "APP_JAPAN=false" >> /var/www/html/.env`,
            `echo "APP_PROFILE=" >> /var/www/html/.env`,
            `echo "APP_DRYRUN=false" >> /var/www/html/.env`,
            `echo "LOG_CHANNEL=stack" >> /var/www/html/.env`,
            `echo "LOG_LEVEL=debug" >> /var/www/html/.env`,
            `echo "DB_CONNECTION=mysql" >> /var/www/html/.env`,

            `echo "DB_PORT=3306" >> /var/www/html/.env`,
            `echo "DB_TABLES_PREFIX=" >> /var/www/html/.env`,
            `echo "DB_HOST=${database.dbInstanceEndpointAddress}" >> /var/www/html/.env`,
            `echo "DB_USERNAME=admin" >> /var/www/html/.env`,
            `DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id '${database.secret?.secretArn}' --query SecretString --output text | jq -r .password)`,
            `if [ -z "$DB_PASSWORD" ]; then echo "Error: DB_PASSWORD is empty"; exit 1; fi`,
            `echo "DB_PASSWORD=$DB_PASSWORD" >> /var/www/html/.env`,
            `echo "DB_DATABASE=${config.databaseName}" >> /var/www/html/.env`,
            `echo "DB_PASSWORD=$DB_PASSWORD" >> /var/www/html/.env`,
            `echo "DB_TIMEZONE='-08:00'  # PST (Standard Time)" >> /var/www/html/.env`,
            `echo "BROADCAST_DRIVER=log" >> /var/www/html/.env`,
            `echo "CACHE_DRIVER=file" >> /var/www/html/.env`,
            `echo "CACHE_PREFIX=acelle_mail_cache" >> /var/www/html/.env`,
            `echo "FILESYSTEM_DRIVER=s3" >> /var/www/html/.env`,
            `echo "QUEUE_CONNECTION=database" >> /var/www/html/.env`,
            `echo "SESSION_DRIVER=file" >> /var/www/html/.env`,
            `echo "SESSION_LIFETIME=120" >> /var/www/html/.env`,
            `echo "MEMCACHED_HOST=127.0.0.1" >> /var/www/html/.env`,
            `echo "REDIS_HOST=127.0.0.1" >> /var/www/html/.env`,
            `echo "REDIS_PASSWORD=null" >> /var/www/html/.env`,
            `echo "REDIS_PORT=6379" >> /var/www/html/.env`,
            `echo "REDIS_PREFIX=acelle_mail_database_" >> /var/www/html/.env`,
            `echo "MAIL_MAILER=smtp" >> /var/www/html/.env`,
            `echo "MAIL_HOST=smtp.gmail.com" >> /var/www/html/.env`,
            `echo "MAIL_PORT=465" >> /var/www/html/.env`,
            `echo "MAIL_USERNAME=infinitietechnologies05@gmail.com" >> /var/www/html/.env`,
            `echo "MAIL_PASSWORD=bjddubtbzwzgcbeq" >> /var/www/html/.env`,
            `echo "MAIL_ENCRYPTION=SSL" >> /var/www/html/.env`,
            `echo "MAIL_FROM_ADDRESS=infinitietechnologies05@gmail.com" >> /var/www/html/.env`,
            `echo "MAIL_FROM_NAME='Harshad Patel'" >> /var/www/html/.env`,
            `echo "AWS_ACCESS_KEY_ID='${process.env.AWS_KEY}'" >> /var/www/html/.env`,
            `echo "AWS_SECRET_ACCESS_KEY='${process.env.AWS_SECRET}'" >> /var/www/html/.env`,
            `echo "AWS_DEFAULT_REGION='us-west-2'" >> /var/www/html/.env`,
            `echo "AWS_BUCKET='dev-image-optimization-st-devzinzuudevbucketimageo-amkqrsnn7nl9'" >> /var/www/html/.env`,
            `echo "AWS_USE_PATH_STYLE_ENDPOINT=true" >> /var/www/html/.env`,
            `echo "AWS_URL='https://dev-cdn.zinzuu.com/'" >> /var/www/html/.env`,
            `echo "AWS_CLOUDFRONT_DISTRIBUTION_ID='E1V1T4547WBLQR'" >> /var/www/html/.env`,
            `echo "AWS_OBJECT='dev-success/'" >> /var/www/html/.env`,
            `echo "PUSHER_APP_ID=" >> /var/www/html/.env`,
            `echo "PUSHER_APP_KEY=" >> /var/www/html/.env`,
            `echo "PUSHER_APP_SECRET=" >> /var/www/html/.env`,
            `echo "PUSHER_APP_CLUSTER=mt1" >> /var/www/html/.env`,
            `echo "MIX_PUSHER_APP_KEY=''" >> /var/www/html/.env`,
            `echo "MIX_PUSHER_APP_CLUSTER=''" >> /var/www/html/.env`,
            `echo "RECAPTCHA_SITEKEY=6LfyISoTAAAAABJV8zycUZNLgd0sj-sBFjctzXKw" >> /var/www/html/.env`,
            `echo "RECAPTCHA_SECRET=6LfyISoTAAAAAC0hJ916unwi0m_B0p7fAvCRK4Kp" >> /var/www/html/.env`,
            `echo "LICENSE_VALIDATION_ENDPOINT=http://verify.acellemail.com" >> /var/www/html/.env`,
            `echo "APP_STORE=false" >> /var/www/html/.env`,
            `echo "DISTRIBUTED_WORKER=false" >> /var/www/html/.env`,
            `echo "SIGN_WITH_DEFAULT_DOMAIN=false" >> /var/www/html/.env`,
            `echo "AUTOMATION_QUEUE_CONNECTION=" >> /var/www/html/.env`,
            `echo "CADDY_AUTOSSL=false" >> /var/www/html/.env`,
            `echo "CADDY_SERVER_HOSTNAME=cname.example.com" >> /var/www/html/.env`,
            `echo "CADDY_ADMIN_EMAIL_ADDRESS=admin@example.com" >> /var/www/html/.env`,
            `echo "ASSET_URL=https://${getDomain(config, config.mainDomain)}" >> /var/www/html/.env`,
            `sudo su ubuntu`,
            `cd ~`,
            `curl -sS https://getcomposer.org/installer -o /tmp/composer-setup.php`,
            "HASH=\`curl -sS https://composer.github.io/installer.sig\`",
            `php -r "if (hash_file('SHA384', '/tmp/composer-setup.php') === '$HASH') { echo 'Installer verified'; } else { echo 'Installer corrupt'; unlink('composer-setup.php'); } echo PHP_EOL;"`,
            `sudo php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer`,
            `cd /var/www/`,
            `sudo chmod +777 -R html`,
            `cd html`,
            `sudo composer install`,
            `cd storage`,
            `sudo mkdir app`,
            'cd app',
            `sudo mkdir quota`,
            `cd ../../../`,
            `sudo chmod -R 777 html`,
            `cd html`,
            'touch storage/app/installed',
            `sudo php artisan storage:link`,
        ];
        userData.addCommands(
            ...commands
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

        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: id + ' CloudFront Distribution for Success site',
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


        // Create a CNAME record
        new aws_route53.CnameRecord(this, 'CnameRecord-main', {
            zone: myHostedZone,
            recordName: config.mainDomain,
            domainName: distribution.distributionDomainName,
            deleteExisting: true,
        });
        // Outputs
        new cdk.CfnOutput(this, 'CloudFrontURL', {value: distribution.distributionDomainName});

        // Output
        new cdk.CfnOutput(this, 'ALBDNS', {value: alb.loadBalancerDnsName});
        new cdk.CfnOutput(this, 'DBEndpoint', {value: database.dbInstanceEndpointAddress});
    }
}

