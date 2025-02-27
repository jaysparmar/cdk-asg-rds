import {EnviornmentConfig} from "../models/enviornmentConfig";
import * as cdk from 'aws-cdk-lib';
import {AwsRegion} from "../enums/regions";


export const environments: EnviornmentConfig[] = [
    {
        stackId: 'prod-success',
        hostedZoneDomain: 'zinzuu.com',
        mainDomain: 'success',
        cdnDomain: 'success-cdn',
        ec2InstanceType: cdk.aws_ec2.InstanceClass.T2,
        ec2InstanceSize: cdk.aws_ec2.InstanceSize.MEDIUM,
        keyPairName: 'zinzuu-prod',
        asgMinCapacity: 1,
        asgMaxCapacity: 3,
        associatePublicIpAddress: false,
        databasePubliclyAccessible: false,
        databaseName: 'zinzuu_success',
        amiRegion: AwsRegion.USWestOregon,
        amiId: 'ami-00c257e12d6828491',
        branchName: "prod"
    }
]
