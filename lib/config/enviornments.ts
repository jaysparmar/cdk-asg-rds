import {EnviornmentConfig} from "../models/enviornmentConfig";
import * as cdk from 'aws-cdk-lib';
import {AwsRegion} from "../enums/regions";


export const environments: EnviornmentConfig[] = [
    {
        stackId: 'jay',
        hostedZoneDomain: 'zinzuu.com',
        apiDomain: 'jay-api',
        merchantDomain: 'jay-merchant',
        mainDomain: 'jay',
        cdnDomain: 'jay-cdn',
        adminDomain: 'jay-admin',
        ec2InstanceType: cdk.aws_ec2.InstanceClass.T2,
        ec2InstanceSize: cdk.aws_ec2.InstanceSize.MEDIUM,
        keyPairName: 'zinzuu-prod',
        asgMinCapacity: 1,
        asgMaxCapacity: 3,
        associatePublicIpAddress: false,
        databasePubliclyAccessible: false,
        databaseName: 'codeigniter',
        amiRegion: AwsRegion.USWestOregon,
        amiId: 'ami-00c257e12d6828491',
        branchName: "main"
    }
]
