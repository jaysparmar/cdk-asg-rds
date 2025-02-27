
import * as cdk from 'aws-cdk-lib';
import {AwsRegion} from "../enums/regions";

export type EnviornmentConfig = {
    stackId: string;
    hostedZoneDomain: string;
    mainDomain: string;
    cdnDomain: string;
    ec2InstanceType:  cdk.aws_ec2.InstanceClass;
    ec2InstanceSize:  cdk.aws_ec2.InstanceSize;
    keyPairName: string;
    asgMinCapacity: number,
    asgMaxCapacity: number,
    associatePublicIpAddress: boolean,
    databasePubliclyAccessible: boolean,
    databaseName: string,
    amiRegion: AwsRegion,
    amiId: string,
    branchName: string
}

