# Lilac

Lilac is "Luscious Infrastructure Living As Code". It's an opinionated take on typical infrastructure-as-code.

Understanding Lilac involves multiple concepts:
1. Flowers (logical services)
    - Petals (individually provisioned infrastructure/microservices)
    - Stems (iac providers, e.g. terraform)
2. Pollen (inter-flower interfacing)
3. Seeds (registry of all available Flowers)

## 1. Flowers

Flowers are logical infrastructural service. Some examples of Flowers are:
1. An api gateway
2. A compute cluster
3. A lambda function
4. A document-style database
5. A relational-style database
5. A blob storage database
6. A queue

The purpose of an infrastructural service is to provide some sort of systems behaviour. In implementing systems, we often have to think about additional, non-behavioural systems concerns - for example, access controls. A Lilac Resource represents only the distilled systems behaviour - when working with Lilac Resources, non-behavioural concerns are abstracted away. Lilac has opinions on how to implement these non-behavioural concerns.

## 2. Lilac Comms (TODO: Rename "comms" -> "bees" / "pollinators" / "pollen"?)

A Lilac Comm represents a dependency between some Lilac Resources. For example, a lambda function may query/insert documents into a document database. A Comm could be used to represent the lambda function's link to the document database.

## 3. IAC Entities

Lilac provides an opinion on how to represent systems, but it is unopinionated about how that representation is consumed and physically provisioned in the world. In provisioning a Lilac setup, the setup as a whole is converted into a number of IAC Entities - these IAC Entities are aware of a particular provisioning strategy, e.g. aws cloudformation or terraform. A set of IAC Entities is essentially the output of a Lilac setup; they allow a Lilac representation to become a real, functioning system.

## 4. Lilac Registry

The Lilac Registry exhaustively represents the set of Lilac Resource types available. For example, a particular systems primitive (e.g. Temporal) may not have a corresponding Lilac Resource. In such a case, if Temporal is desired, a new Lilac Resource would have to be written for it, and added to the Registry. The Registry also enables development-time testing - a fully mocked Registry can be substituted to the Lilac setup, and the result will be a true-to-production test environment (e.g. local testing).

## 5. The Patio

IAC deploys always involve the creation of infrastructure-describing code, which is abstracted away by Lilac and treated as ephemeral. But sometimes, deploys also involve the creation of files which are expected to be checked into version control. The "patio" is a file pointer that ought to be provided by the consumer, and points to some arbitrary directory in their control, which is checked into version control. Lilac will populate this directory, and pull from it appropriately (in order to reproduce deploys where ephemeral code is generated, and version-controlled code is still version-controlled). Note a good example of a version-controlled IAC file is terraform's .terraform.lock.hcl file!