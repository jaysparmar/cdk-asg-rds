#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2LbAsgStack } from '../lib/ec2-lb-asg-stack';
import * as dotenv from 'dotenv';
import {aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, Stack} from 'aws-cdk-lib';
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import {environments} from "../lib/config/enviornments";
import {ImageOptimizationStack} from "../lib/image-optimization-stack";
import {ASSET_STACK_STRING} from "../lib/config/constants";
export const app = new cdk.App();
// Load environment variables from .env file
dotenv.config();



environments.forEach(env => {

    try{

        new ImageOptimizationStack(app, `${env.stackId}${ASSET_STACK_STRING}`, {
            env: {
                account: process.env.CDK_DEFAULT_ACCOUNT, // Replace with your AWS account ID if not using default
                region: 'us-west-2', // Replace with your desired region
            },
            crossRegionReferences: true,
        });



        new Ec2LbAsgStack(app, env.stackId, {
            /* If you don't specify 'env', this stack will be environment-agnostic.
             * Account/Region-dependent features and context lookups will not work,
             * but a single synthesized template can be deployed anywhere. */

            env: {
                account: process.env.CDK_DEFAULT_ACCOUNT,
                region: 'us-west-2',
            },
            crossRegionReferences: true,
            /* Uncomment the next line to specialize this stack for the AWS Account
             * and Region that are implied by the current CLI configuration. */
            // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

            /* Uncomment the next line if you know exactly what Account and Region you
             * want to deploy the stack to. */
            // env: { account: '123456789012', region: 'us-east-1' },

            /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
        });
    }catch (e){
        console.log(e);
    }

});





