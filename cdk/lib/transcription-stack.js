const path = require('path');
const { Stack, CfnOutput, Duration } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const iam = require('aws-cdk-lib/aws-iam');

class TranscriptionStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // -------------------------------------------------------
    // IAM Role for Transcription Lambda
    // Grants access to Transcribe Streaming and Translate
    // -------------------------------------------------------
    const transcriptionRole = new iam.Role(this, 'TranscriptionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Transcription Orchestrator Lambda with Transcribe and Translate access',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant Transcribe Streaming permissions
    transcriptionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['transcribe:StartStreamTranscription'],
      resources: ['*'],
    }));

    // Grant Translate permissions
    transcriptionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

    // -------------------------------------------------------
    // Lambda Function for Transcription Orchestration
    // -------------------------------------------------------
    const transcriptionFunction = new lambda.Function(this, 'TranscriptionFunction', {
      functionName: 'VirtualMeetup-Transcription',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/transcription/')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: transcriptionRole,
    });

    // -------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'TranscriptionFunctionArn', {
      value: transcriptionFunction.functionArn,
      description: 'ARN of the Transcription Orchestrator Lambda function',
      exportName: 'TranscriptionFunctionArn',
    });

    // Expose Lambda function reference for cross-stack use
    this.transcriptionFunction = transcriptionFunction;
  }
}

module.exports = { TranscriptionStack };
