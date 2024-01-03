# eks-reference-deployment-pulumi-typescript

## Summary

This is a reference deployment of a simple EKS cluster with Pulumi using Typescript. This guide assumes some know-how with Pulumi and AWS.

## Deployment overview

- EKS Cluster
- Roles, Policies and Role Attachments
- EKS Addons: VPC, CoreDNS, EBS driver, Kube Proxy
- A Node Group for the EKS cluster
- Autoscaling for the cluster
- Argo CD helm chart

Please check the comments inline for more details.

## Quick start

### AWS Credentials

See https://www.pulumi.com/registry/packages/aws/installation-configuration/ regarding authentication with AWS.

### Deployment

Switch to the pulumi-iac directory:

```bash
cd pulumi-iac
```

Make sure you add your public IP address in the Pulumi.eks-pulumi-iac.yaml file.

Preview the changes:

```bash
pulumi preview
```

Deploy the changes:

```bash
pulumi up
```

The deployment will output a kubeconfig which we can use to interact with the cluster.
