import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';


export class Ec2LbAsgStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubToken: string | undefined = process.env.GITHUB_TOKEN;

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
      databaseName: 'codeigniter',
      vpc,
      securityGroups: [rdsSG],
      allocatedStorage: 20,
      publiclyAccessible: false,
    });

    // Step 4: User Data Script
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
        'sudo su',
        'apt-get update -y',
        'apt-get install -y software-properties-common',
        'add-apt-repository ppa:ondrej/php -y',
        'apt-get update -y',
        'apt-get install -y php8.0 php8.0-mysql php8.0-curl apache2 git',
        'systemctl start apache2',
        'systemctl enable apache2',
        'rm -rf /var/www/html',
        'git clone https://'+githubToken+'@github.com/ZinZuu-Dev/zinzuu-web.git /var/www/html || (cd /var/www/html && git pull origin main)',
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
        'systemctl reload apache2'
    );

    // Step 5: Create Auto Scaling Group
    const ec2Role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MEDIUM),
      machineImage: new ec2.GenericLinuxImage({
        'us-west-2': 'ami-00c257e12d6828491', // Replace with the latest Ubuntu AMI ID for your region
      }),
      role: ec2Role,
      securityGroup: instanceSG,
      userData,
      minCapacity: 1,
      maxCapacity: 3,
      keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPair', 'zinzuu-prod'),
      // associatePublicIpAddress: true,
    });

    // Step 6: Create Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

    const listener  = alb.addListener('Listener', {
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
      });
    // Outputs
    new cdk.CfnOutput(this, 'CloudFrontURL', { value: distribution.distributionDomainName });

    // Output
    new cdk.CfnOutput(this, 'ALBDNS', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'DBEndpoint', { value: database.dbInstanceEndpointAddress });
  }
}
