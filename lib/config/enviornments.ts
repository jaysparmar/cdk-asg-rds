import {EnviornmentConfig} from "../models/enviornmentConfig";
import * as cdk from 'aws-cdk-lib';
import {AwsRegion} from "../enums/regions";


export const environments: EnviornmentConfig[] = [
    {
        stackId: 'test',
        hostedZoneDomain: 'zinzuu.com',
        apiDomain: 'test-api',
        merchantDomain: 'test-merchant',
        mainDomain: 'test',
        cdnDomain: 'test-cdn',
        adminDomain: 'test-admin',
        ec2InstanceType: cdk.aws_ec2.InstanceClass.T2,
        ec2InstanceSize: cdk.aws_ec2.InstanceSize.MEDIUM,
        keyPairName: 'zinzuu-prod',
        asgMinCapacity: 1,
        asgMaxCapacity: 3,
        associatePublicIpAddress: false,
        databasePubliclyAccessible: false,
        databaseName: 'codeigniter',
        amiRegion: AwsRegion.USWestOregon,
        amiId: 'ami-00c257e12d6828491'
    }
]
